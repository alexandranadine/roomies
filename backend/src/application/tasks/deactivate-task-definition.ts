import {
  lockHomeAndExactMemberships,
  type LockedHomeAndExactMemberships,
} from '../../domains/homes/lock-home-and-exact-memberships.js';
import { decideTaskDefinitionDeactivate } from '../../domains/tasks/definition-deactivate-policy.js';
import { TaskDefinitionAlreadyDeactivatedError } from '../../domains/tasks/errors.js';
import {
  createTaskRepository,
  type DeactivateActiveTaskDefinition,
  type TaskRepository,
} from '../../domains/tasks/repository.js';
import type { TaskDefinition } from '../../domains/tasks/task-definition.js';
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

export type DeactivateTaskDefinitionInput = Readonly<{
  actor: ActiveHomeActor;
  homeId: string;
  taskDefinitionId: string;
}>;

export type DeactivateTaskDefinitionDependencies = Readonly<{
  runTransaction: <T>(
    work: (tx: TransactionContext) => Promise<T>,
  ) => Promise<T>;
  lockHomeAndExactMemberships: LockHomeAndExactMemberships;
  tasks: Pick<
    TaskRepository,
    'lockDefinitionByHomeAndId' | 'deactivateActiveDefinition'
  >;
  clock: Clock;
}>;

function revalidatedActor(
  locked: LockedHomeAndExactMemberships,
  input: DeactivateTaskDefinitionInput,
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

function assertStillActive(definition: TaskDefinition): void {
  if (
    definition.deactivatedAt !== null ||
    definition.nextOccurrenceDate === null ||
    definition.nextOccurrenceAt === null
  ) {
    throw new TaskDefinitionAlreadyDeactivatedError();
  }
}

/**
 * Deactivates one active TaskDefinition in an authorized Home.
 *
 * Mutation order inside READ COMMITTED:
 * Home FOR UPDATE → exact actor Membership FOR UPDATE → revalidate Home →
 * revalidate actor → lock TaskDefinition by homeId + id → concealed 404 if
 * absent → authorize exact creator or ADMIN → already-deactivated 409 →
 * Clock.now() → atomic lifecycle UPDATE.
 */
export function createDeactivateTaskDefinition(
  deps: DeactivateTaskDefinitionDependencies,
): (input: DeactivateTaskDefinitionInput) => Promise<TaskDefinition> {
  return async (input) => {
    return deps.runTransaction(async (tx) => {
      const locked = await deps.lockHomeAndExactMemberships(tx, {
        homeId: input.homeId,
        membershipIds: Object.freeze([input.actor.membershipId]),
      });

      const actor = revalidatedActor(locked, input);
      const definition = await deps.tasks.lockDefinitionByHomeAndId(
        tx,
        locked.home.id,
        input.taskDefinitionId,
      );
      if (definition === null) {
        throw new ConcealedNotFoundError();
      }

      const authorization = decideTaskDefinitionDeactivate({
        actor,
        targetHomeId: locked.home.id,
        creatorMembershipId: definition.creatorMembershipId,
      });
      if (!authorization.allowed) {
        throw new ConcealedNotFoundError();
      }

      assertStillActive(definition);

      const deactivatedAt = deps.clock.now();
      const persistable: DeactivateActiveTaskDefinition = Object.freeze({
        homeId: locked.home.id,
        taskDefinitionId: definition.id,
        deactivatedAt,
      });
      const deactivated = await deps.tasks.deactivateActiveDefinition(
        tx,
        persistable,
      );
      if (deactivated === null) {
        throw new TaskDefinitionAlreadyDeactivatedError();
      }
      return deactivated;
    });
  };
}

export function createDeactivateTaskDefinitionFromPool(
  pool: TransactionPool,
): ReturnType<typeof createDeactivateTaskDefinition> {
  return createDeactivateTaskDefinition({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeAndExactMemberships,
    tasks: createTaskRepository(
      pool as Parameters<typeof createTaskRepository>[0],
    ),
    clock: systemClock,
  });
}
