import {
  lockHomeAndExactMemberships,
  type LockedHomeAndExactMemberships,
} from '../../domains/homes/lock-home-and-exact-memberships.js';
import { decideTaskCreate } from '../../domains/tasks/create-policy.js';
import {
  InvalidHomeLocalDateError,
  InvalidTaskTitleError,
} from '../../domains/tasks/errors.js';
import { parseHomeLocalDate } from '../../domains/tasks/home-local-date.js';
import {
  createTaskRepository,
  type NewManualTaskInstance,
  type TaskRepository,
} from '../../domains/tasks/repository.js';
import type { TaskInstance } from '../../domains/tasks/task.js';
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

export type CreateManualTaskInput = Readonly<{
  actor: ActiveHomeActor;
  homeId: string;
  title: string;
  assignedMembershipId?: string | null;
  scheduledFor?: string | null;
}>;

export type LockHomeAndExactMemberships = (
  tx: TransactionContext,
  input: {
    homeId: string;
    membershipIds: readonly string[];
  },
) => Promise<LockedHomeAndExactMemberships>;

export type CreateManualTaskDependencies = Readonly<{
  runTransaction: <T>(
    work: (tx: TransactionContext) => Promise<T>,
  ) => Promise<T>;
  lockHomeAndExactMemberships: LockHomeAndExactMemberships;
  tasks: Pick<TaskRepository, 'insertManual'>;
  clock: Clock;
  ids: UuidV7Generator;
}>;

function normalizedScheduledFor(
  value: string | null | undefined,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  try {
    return parseHomeLocalDate(value);
  } catch (error) {
    if (error instanceof InvalidHomeLocalDateError) {
      throw new InvalidRequestError();
    }
    throw error;
  }
}

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
  input: CreateManualTaskInput,
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

/**
 * Creates one OPEN MANUAL TaskInstance for an authorized Home.
 * Assignment is optional exact active same-Home Membership tenure.
 *
 * Mutation order inside READ COMMITTED:
 * Home FOR UPDATE → revalidate Home → exact Membership FOR UPDATE in id
 * order → revalidate actor (and assignee) → authorize task.create → INSERT.
 */
export function createCreateManualTask(
  deps: CreateManualTaskDependencies,
): (input: CreateManualTaskInput) => Promise<TaskInstance> {
  return async (input) => {
    const early = decideTaskCreate({
      actor: input.actor,
      targetHomeId: input.homeId,
    });
    if (!early.allowed) {
      throw new ConcealedNotFoundError();
    }

    const title = normalizedTitle(input.title);
    const scheduledFor = normalizedScheduledFor(input.scheduledFor);
    const assignedMembershipId = normalizedAssignedMembershipId(
      input.assignedMembershipId,
    );
    const taskId = deps.ids.next();
    const occurredAt = deps.clock.now();

    return deps.runTransaction(async (tx) => {
      const locked = await deps.lockHomeAndExactMemberships(tx, {
        homeId: input.homeId,
        membershipIds: membershipIdsToLock(
          input.actor.membershipId,
          assignedMembershipId,
        ),
      });

      const actor = revalidatedActor(locked, input);
      const authorization = decideTaskCreate({
        actor,
        targetHomeId: locked.home.id,
      });
      if (!authorization.allowed) {
        throw new ConcealedNotFoundError();
      }

      if (assignedMembershipId !== null) {
        assertAssigneeStillActive(locked, assignedMembershipId);
      }

      const persistable: NewManualTaskInstance = Object.freeze({
        id: taskId,
        homeId: locked.home.id,
        title,
        scheduledFor,
        assignedMembershipId,
        createdAt: occurredAt,
      });
      return deps.tasks.insertManual(tx, persistable);
    });
  };
}

export function createCreateManualTaskFromPool(
  pool: TransactionPool,
): ReturnType<typeof createCreateManualTask> {
  return createCreateManualTask({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeAndExactMemberships,
    tasks: createTaskRepository(
      pool as Parameters<typeof createTaskRepository>[0],
    ),
    clock: systemClock,
    ids: systemUuidV7,
  });
}
