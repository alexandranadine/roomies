import { Temporal } from '@js-temporal/polyfill';
import {
  tryLockHomeAndExactMemberships,
  type LockedHomeAndExactMemberships,
  type TryLockHomeAndExactMemberships,
} from '../../domains/homes/lock-home-and-exact-memberships.js';
import { TaskPersistenceError } from '../../domains/tasks/errors.js';
import {
  createTaskRepository,
  type DueTaskDefinitionCandidate,
  type NewRecurringTaskOccurrence,
  type TaskRepository,
} from '../../domains/tasks/repository.js';
import { computeNextRecurrenceCursor } from '../../domains/tasks/recurrence-cursor.js';
import type { TaskDefinition } from '../../domains/tasks/task-definition.js';
import type { UuidV7Generator } from '../../platform/ids/uuid-v7.js';
import { systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import {
  runInReadCommittedTransaction,
  type TransactionContext,
  type TransactionPool,
} from '../../platform/persistence/transaction.js';
import type { Clock } from '../../platform/time/clock.js';
import { systemClock } from '../../platform/time/clock.js';

export const DEFAULT_MAX_RECURRING_DEFINITIONS_PER_INVOCATION = 25;
export const DEFAULT_MAX_OCCURRENCES_PER_RECURRING_DEFINITION = 100;
const MAX_CANDIDATE_ATTEMPTS_PER_DEFINITION_SLOT = 4;

export type ProcessDueRecurringTasksOptions = Readonly<{
  maxDefinitions?: number;
  maxOccurrencesPerDefinition?: number;
}>;

export type ProcessDueRecurringTasksResult = Readonly<{
  definitionsProcessed: number;
  occurrencesGenerated: number;
  occurrencesReconciled: number;
  moreDueWorkLikely: boolean;
}>;

type ProcessedDefinition = Readonly<{
  processed: boolean;
  generated: number;
  reconciled: number;
  remainsDue: boolean;
}>;

export type ProcessDueRecurringTasksDependencies = Readonly<{
  runTransaction: <T>(
    work: (tx: TransactionContext) => Promise<T>,
  ) => Promise<T>;
  tryLockHomeAndExactMemberships: TryLockHomeAndExactMemberships;
  tasks: Pick<
    TaskRepository,
    | 'findNextDueDefinitionCandidate'
    | 'lockDueDefinitionByHomeAndId'
    | 'insertRecurringOccurrence'
    | 'advanceDefinitionCursor'
  >;
  clock: Clock;
  ids: UuidV7Generator;
}>;

function positiveInteger(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(
      'Recurring task processing limits must be positive integers',
    );
  }
  return resolved;
}

function isDue(definition: TaskDefinition, workerNow: Date): boolean {
  return (
    definition.deactivatedAt === null &&
    definition.nextOccurrenceDate !== null &&
    definition.nextOccurrenceAt !== null &&
    definition.nextOccurrenceAt.getTime() <= workerNow.getTime()
  );
}

function lockedAssigneeIsValid(
  locked: LockedHomeAndExactMemberships,
  assignedMembershipId: string,
): boolean {
  const membership = locked.memberships.find(
    (row) => row.id === assignedMembershipId,
  );
  return (
    membership !== undefined &&
    membership.homeId === locked.home.id &&
    membership.endedAt === null
  );
}

function sameAssignmentSnapshot(
  candidate: DueTaskDefinitionCandidate,
  definition: TaskDefinition,
): boolean {
  return (
    candidate.assignedMembershipId === definition.assignedMembershipId ||
    definition.assignedMembershipId === null
  );
}

async function processCandidate(
  deps: ProcessDueRecurringTasksDependencies,
  candidate: DueTaskDefinitionCandidate,
  workerNow: Date,
  maxOccurrences: number,
): Promise<ProcessedDefinition> {
  return deps.runTransaction(async (tx) => {
    const locked = await deps.tryLockHomeAndExactMemberships(tx, {
      homeId: candidate.homeId,
      membershipIds:
        candidate.assignedMembershipId === null
          ? Object.freeze([])
          : Object.freeze([candidate.assignedMembershipId]),
    });
    if (locked === null) {
      return {
        processed: false,
        generated: 0,
        reconciled: 0,
        remainsDue: true,
      };
    }

    let definition = await deps.tasks.lockDueDefinitionByHomeAndId(
      tx,
      locked.home.id,
      candidate.id,
      workerNow,
    );
    if (definition === null) {
      return {
        processed: false,
        generated: 0,
        reconciled: 0,
        remainsDue: false,
      };
    }

    // A changed non-null assignee was not locked in canonical order. Leave the
    // candidate for a later invocation rather than inverting Membership → Task.
    if (!sameAssignmentSnapshot(candidate, definition)) {
      return {
        processed: false,
        generated: 0,
        reconciled: 0,
        remainsDue: true,
      };
    }
    if (
      definition.assignedMembershipId !== null &&
      !lockedAssigneeIsValid(locked, definition.assignedMembershipId)
    ) {
      throw new TaskPersistenceError();
    }

    let generated = 0;
    let reconciled = 0;
    let processedOccurrences = 0;

    while (
      isDue(definition, workerNow) &&
      processedOccurrences < maxOccurrences
    ) {
      const occurrenceDate = definition.nextOccurrenceDate;
      if (occurrenceDate === null) {
        throw new TaskPersistenceError();
      }

      const occurrence: NewRecurringTaskOccurrence = Object.freeze({
        id: deps.ids.next(),
        homeId: definition.homeId,
        taskDefinitionId: definition.id,
        title: definition.title,
        scheduledFor: occurrenceDate,
        assignedMembershipId: definition.assignedMembershipId,
        createdAt: workerNow,
      });
      const insertResult = await deps.tasks.insertRecurringOccurrence(
        tx,
        occurrence,
      );

      const successor = computeNextRecurrenceCursor({
        frequency: definition.frequency,
        weekday: definition.weekday,
        dayOfMonth: definition.dayOfMonth,
        homeTimeZone: locked.home.timezone,
        previousOccurrenceDate: occurrenceDate,
      });
      if (
        Temporal.PlainDate.compare(successor.occurrenceDate, occurrenceDate) <=
        0
      ) {
        throw new TaskPersistenceError();
      }

      definition = await deps.tasks.advanceDefinitionCursor(tx, {
        homeId: definition.homeId,
        taskDefinitionId: definition.id,
        nextOccurrenceDate: successor.occurrenceDate,
        nextOccurrenceAt: successor.occurrenceAt,
        updatedAt: workerNow,
      });
      processedOccurrences += 1;
      if (insertResult === 'generated') {
        generated += 1;
      } else {
        reconciled += 1;
      }
    }

    return Object.freeze({
      processed: true,
      generated,
      reconciled,
      remainsDue: isDue(definition, workerNow),
    });
  });
}

/**
 * One bounded trusted-system recurrence processing invocation.
 *
 * `workerNow` is captured once from the injected Clock and is used for every
 * due comparison and every generated row's created_at/updated_at.
 */
export function createProcessDueRecurringTasks(
  deps: ProcessDueRecurringTasksDependencies,
): (
  options?: ProcessDueRecurringTasksOptions,
) => Promise<ProcessDueRecurringTasksResult> {
  return async (options = {}) => {
    const maxDefinitions = positiveInteger(
      options.maxDefinitions,
      DEFAULT_MAX_RECURRING_DEFINITIONS_PER_INVOCATION,
    );
    const maxOccurrences = positiveInteger(
      options.maxOccurrencesPerDefinition,
      DEFAULT_MAX_OCCURRENCES_PER_RECURRING_DEFINITION,
    );
    const workerNow = deps.clock.now();
    if (Number.isNaN(workerNow.valueOf())) {
      throw new RangeError('Clock returned an invalid worker timestamp');
    }

    const attemptedDefinitionIds: string[] = [];
    const maxCandidateAttempts = Math.min(
      Number.MAX_SAFE_INTEGER,
      maxDefinitions * MAX_CANDIDATE_ATTEMPTS_PER_DEFINITION_SLOT,
    );
    let candidateAttempts = 0;
    let definitionsProcessed = 0;
    let occurrencesGenerated = 0;
    let occurrencesReconciled = 0;
    let moreDueWorkLikely = false;

    while (
      definitionsProcessed < maxDefinitions &&
      candidateAttempts < maxCandidateAttempts
    ) {
      const candidate = await deps.tasks.findNextDueDefinitionCandidate(
        workerNow,
        attemptedDefinitionIds,
      );
      if (candidate === null) {
        break;
      }
      candidateAttempts += 1;
      attemptedDefinitionIds.push(candidate.id);

      const result = await processCandidate(
        deps,
        candidate,
        workerNow,
        maxOccurrences,
      );
      if (!result.processed) {
        moreDueWorkLikely ||= result.remainsDue;
        continue;
      }

      definitionsProcessed += 1;
      occurrencesGenerated += result.generated;
      occurrencesReconciled += result.reconciled;
      moreDueWorkLikely ||= result.remainsDue;
    }

    if (definitionsProcessed === maxDefinitions) {
      moreDueWorkLikely = true;
    }
    if (candidateAttempts === maxCandidateAttempts) {
      moreDueWorkLikely = true;
    }

    return Object.freeze({
      definitionsProcessed,
      occurrencesGenerated,
      occurrencesReconciled,
      moreDueWorkLikely,
    });
  };
}

export function createProcessDueRecurringTasksFromPool(
  pool: TransactionPool,
): ReturnType<typeof createProcessDueRecurringTasks> {
  return createProcessDueRecurringTasks({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    tryLockHomeAndExactMemberships,
    tasks: createTaskRepository(
      pool as Parameters<typeof createTaskRepository>[0],
    ),
    clock: systemClock,
    ids: systemUuidV7,
  });
}
