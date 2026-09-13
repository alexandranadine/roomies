import { Temporal } from '@js-temporal/polyfill';
import {
  lockHomeAndExactMemberships,
  type LockedHomeAndExactMemberships,
} from '../../domains/homes/lock-home-and-exact-memberships.js';
import { decideTaskDefinitionCreate } from '../../domains/tasks/definition-create-policy.js';
import {
  InvalidRecurrenceConfigurationError,
  InvalidTaskTitleError,
} from '../../domains/tasks/errors.js';
import {
  createTaskRepository,
  type NewTaskDefinition,
  type TaskRepository,
} from '../../domains/tasks/repository.js';
import { normalizeRecurrenceConfiguration } from '../../domains/tasks/recurrence-config.js';
import { computeInitialRecurrenceCursor } from '../../domains/tasks/recurrence-cursor.js';
import type { TaskRecurrenceFrequency } from '../../domains/tasks/recurrence-cursor.js';
import type { TaskDefinition } from '../../domains/tasks/task-definition.js';
import { normalizeTaskTitle } from '../../domains/tasks/task-title.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  InvalidRequestError,
} from '../../platform/authz/errors.js';
import { pathUuidSchema } from '../../platform/http/path-id.js';
import type { UuidV7Generator } from '../../platform/ids/uuid-v7.js';
import { systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import {
  runInReadCommittedTransaction,
  type TransactionContext,
  type TransactionPool,
} from '../../platform/persistence/transaction.js';
import type { Clock } from '../../platform/time/clock.js';
import { systemClock } from '../../platform/time/clock.js';
import type { LockHomeAndExactMemberships } from './create-manual-task.js';

export type CreateRecurringTaskDefinitionInput = Readonly<{
  actor: ActiveHomeActor;
  homeId: string;
  title: string;
  frequency: TaskRecurrenceFrequency;
  weekday?: number | null;
  dayOfMonth?: number | null;
  assignedMembershipId?: string | null;
}>;

export type CreateRecurringTaskDefinitionDependencies = Readonly<{
  runTransaction: <T>(
    work: (tx: TransactionContext) => Promise<T>,
  ) => Promise<T>;
  lockHomeAndExactMemberships: LockHomeAndExactMemberships;
  tasks: Pick<TaskRepository, 'insertDefinition'>;
  clock: Clock;
  ids: UuidV7Generator;
}>;

function normalizedTitle(value: string): string {
  try {
    return normalizeTaskTitle(value);
  } catch (error) {
    if (error instanceof InvalidTaskTitleError) {
      throw new InvalidRequestError();
    }
    throw error;
  }
}

function normalizedAssignedMembershipId(
  value: string | null | undefined,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const parsed = pathUuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidRequestError();
  }
  return parsed.data;
}

function membershipIdsToLock(
  actorMembershipId: string,
  assignedMembershipId: string | null,
): readonly string[] {
  if (
    assignedMembershipId === null ||
    assignedMembershipId === actorMembershipId
  ) {
    return Object.freeze([actorMembershipId]);
  }
  return Object.freeze([actorMembershipId, assignedMembershipId]);
}

function revalidatedActor(
  locked: LockedHomeAndExactMemberships,
  input: CreateRecurringTaskDefinitionInput,
): ActiveHomeActor {
  if (locked.home.id !== input.homeId || locked.home.archivedAt !== null) {
    throw new ConcealedNotFoundError();
  }

  const actorRow = locked.memberships.find(
    (membership) => membership.id === input.actor.membershipId,
  );
  if (
    actorRow === undefined ||
    actorRow.endedAt !== null ||
    actorRow.userId !== input.actor.userId ||
    actorRow.homeId !== input.homeId ||
    actorRow.homeId !== input.actor.homeId ||
    actorRow.id !== input.actor.membershipId
  ) {
    throw new ConcealedNotFoundError();
  }

  return Object.freeze({
    userId: actorRow.userId,
    membershipId: actorRow.id,
    homeId: actorRow.homeId,
    role: actorRow.role,
  });
}

function assertAssigneeStillActive(
  locked: LockedHomeAndExactMemberships,
  assignedMembershipId: string,
): void {
  const assigneeRow = locked.memberships.find(
    (membership) => membership.id === assignedMembershipId,
  );
  if (
    assigneeRow === undefined ||
    assigneeRow.endedAt !== null ||
    assigneeRow.homeId !== locked.home.id
  ) {
    throw new InvalidRequestError();
  }
}

function normalizedRecurrence(input: CreateRecurringTaskDefinitionInput): {
  frequency: TaskRecurrenceFrequency;
  weekday: number | null;
  dayOfMonth: number | null;
} {
  try {
    return normalizeRecurrenceConfiguration({
      frequency: input.frequency,
      weekday: input.weekday,
      dayOfMonth: input.dayOfMonth,
    });
  } catch (error) {
    if (error instanceof InvalidRecurrenceConfigurationError) {
      throw new InvalidRequestError();
    }
    throw error;
  }
}

/**
 * Creates one active recurring TaskDefinition for an authorized Home.
 * No TaskInstance is generated. The initial cursor is computed from the
 * locked Home timezone after structural locks.
 *
 * Mutation order inside READ COMMITTED:
 * Home FOR UPDATE → exact Membership FOR UPDATE in id order → revalidate
 * Home → revalidate actor → authorize task_definition.create → revalidate
 * assignee → validate recurrence → UUIDv7 → Clock.now() → initial cursor →
 * INSERT.
 */
export function createCreateRecurringTaskDefinition(
  deps: CreateRecurringTaskDefinitionDependencies,
): (input: CreateRecurringTaskDefinitionInput) => Promise<TaskDefinition> {
  return async (input) => {
    const early = decideTaskDefinitionCreate({
      actor: input.actor,
      targetHomeId: input.homeId,
    });
    if (!early.allowed) {
      throw new ConcealedNotFoundError();
    }

    const title = normalizedTitle(input.title);
    const assignedMembershipId = normalizedAssignedMembershipId(
      input.assignedMembershipId,
    );

    return deps.runTransaction(async (tx) => {
      const locked = await deps.lockHomeAndExactMemberships(tx, {
        homeId: input.homeId,
        membershipIds: membershipIdsToLock(
          input.actor.membershipId,
          assignedMembershipId,
        ),
      });

      const actor = revalidatedActor(locked, input);
      const authorization = decideTaskDefinitionCreate({
        actor,
        targetHomeId: locked.home.id,
      });
      if (!authorization.allowed) {
        throw new ConcealedNotFoundError();
      }

      if (assignedMembershipId !== null) {
        assertAssigneeStillActive(locked, assignedMembershipId);
      }

      const recurrence = normalizedRecurrence(input);
      const definitionId = deps.ids.next();
      const createdAt = deps.clock.now();

      let cursor;
      try {
        cursor = computeInitialRecurrenceCursor({
          frequency: recurrence.frequency,
          weekday: recurrence.weekday,
          dayOfMonth: recurrence.dayOfMonth,
          homeTimeZone: locked.home.timezone,
          createdAt: Temporal.Instant.from(createdAt.toISOString()),
        });
      } catch (error) {
        if (error instanceof RangeError) {
          throw new InvalidRequestError();
        }
        throw error;
      }

      const persistable: NewTaskDefinition = Object.freeze({
        id: definitionId,
        homeId: locked.home.id,
        title,
        frequency: recurrence.frequency,
        weekday: recurrence.weekday,
        dayOfMonth: recurrence.dayOfMonth,
        assignedMembershipId,
        creatorMembershipId: actor.membershipId,
        nextOccurrenceDate: cursor.occurrenceDate,
        nextOccurrenceAt: cursor.occurrenceAt,
        createdAt,
      });
      return deps.tasks.insertDefinition(tx, persistable);
    });
  };
}

export function createCreateRecurringTaskDefinitionFromPool(
  pool: TransactionPool,
): ReturnType<typeof createCreateRecurringTaskDefinition> {
  return createCreateRecurringTaskDefinition({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeAndExactMemberships,
    tasks: createTaskRepository(
      pool as Parameters<typeof createTaskRepository>[0],
    ),
    clock: systemClock,
    ids: systemUuidV7,
  });
}
