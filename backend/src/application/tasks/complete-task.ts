import {
  lockHomeAndExactMemberships,
  type LockedHomeAndExactMemberships,
} from '../../domains/homes/lock-home-and-exact-memberships.js';
import { decideTaskComplete } from '../../domains/tasks/complete-policy.js';
import { TaskAlreadyCompletedError } from '../../domains/tasks/errors.js';
import {
  createTaskRepository,
  type CompleteOpenTaskInstance,
  type TaskRepository,
} from '../../domains/tasks/repository.js';
import type { TaskInstance } from '../../domains/tasks/task.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import {
  runInReadCommittedTransaction,
  type TransactionContext,
  type TransactionPool,
} from '../../platform/persistence/transaction.js';
import type { Clock } from '../../platform/time/clock.js';
import { systemClock } from '../../platform/time/clock.js';
import type { LockHomeAndExactMemberships } from './create-manual-task.js';

export type CompleteTaskInput = Readonly<{
  actor: ActiveHomeActor;
  homeId: string;
  taskId: string;
}>;

export type CompleteTaskDependencies = Readonly<{
  runTransaction: <T>(
    work: (tx: TransactionContext) => Promise<T>,
  ) => Promise<T>;
  lockHomeAndExactMemberships: LockHomeAndExactMemberships;
  tasks: Pick<TaskRepository, 'lockByHomeAndId' | 'completeOpenTask'>;
  clock: Clock;
}>;

function revalidatedActor(
  locked: LockedHomeAndExactMemberships,
  input: CompleteTaskInput,
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

function assertStillOpen(task: TaskInstance): void {
  if (task.status === 'COMPLETED' || task.completedAt !== null) {
    throw new TaskAlreadyCompletedError();
  }
}

/**
 * Completes one OPEN TaskInstance in an authorized Home.
 * Source is not special-cased: MANUAL and RECURRING instances share this path.
 *
 * Mutation order inside READ COMMITTED:
 * Home FOR UPDATE → revalidate Home → exact actor Membership FOR UPDATE →
 * revalidate actor → authorize task.complete → Task FOR UPDATE scoped by
 * homeId + taskId → revalidate OPEN → conditional OPEN → COMPLETED UPDATE.
 */
export function createCompleteTask(
  deps: CompleteTaskDependencies,
): (input: CompleteTaskInput) => Promise<TaskInstance> {
  return async (input) => {
    const early = decideTaskComplete({
      actor: input.actor,
      targetHomeId: input.homeId,
    });
    if (!early.allowed) {
      throw new ConcealedNotFoundError();
    }

    const occurredAt = deps.clock.now();

    return deps.runTransaction(async (tx) => {
      const locked = await deps.lockHomeAndExactMemberships(tx, {
        homeId: input.homeId,
        membershipIds: Object.freeze([input.actor.membershipId]),
      });

      const actor = revalidatedActor(locked, input);
      const authorization = decideTaskComplete({
        actor,
        targetHomeId: locked.home.id,
      });
      if (!authorization.allowed) {
        throw new ConcealedNotFoundError();
      }

      const task = await deps.tasks.lockByHomeAndId(
        tx,
        locked.home.id,
        input.taskId,
      );
      if (task === null) {
        throw new ConcealedNotFoundError();
      }

      assertStillOpen(task);

      const persistable: CompleteOpenTaskInstance = Object.freeze({
        homeId: locked.home.id,
        taskId: task.id,
        completedAt: occurredAt,
        updatedAt: occurredAt,
      });
      const completed = await deps.tasks.completeOpenTask(tx, persistable);
      if (completed === null) {
        throw new TaskAlreadyCompletedError();
      }
      return completed;
    });
  };
}

export function createCompleteTaskFromPool(
  pool: TransactionPool,
): ReturnType<typeof createCompleteTask> {
  return createCompleteTask({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeAndExactMemberships,
    tasks: createTaskRepository(
      pool as Parameters<typeof createTaskRepository>[0],
    ),
    clock: systemClock,
  });
}
