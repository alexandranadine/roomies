import type { MembershipEndedCause } from '../../domains/memberships/events.js';
import {
  createTaskRepository,
  type TaskRepository,
} from '../../domains/tasks/repository.js';
import type {
  TransactionContext,
  TransactionPool,
} from '../../platform/persistence/transaction.js';

/**
 * Tasks-owned public seam for synchronous membership-ending cleanup.
 * Callers must already hold Home/Membership structural locks and pass the
 * existing transaction plus the shared operation timestamp.
 *
 * Does not begin, commit, or roll back a transaction. Does not emit Task
 * events. Does not lock Home or Membership.
 */
export type MembershipEndingTaskCleanupInput = Readonly<{
  homeId: string;
  membershipId: string;
  endedAt: Date;
  cause: MembershipEndedCause;
}>;

export type MembershipEndingTaskCleanup = Readonly<{
  handleMembershipEnded(
    tx: TransactionContext,
    input: MembershipEndingTaskCleanupInput,
  ): Promise<void>;
}>;

export type MembershipEndingTaskCleanupTasks = Pick<
  TaskRepository,
  'unassignOpenTasksForMembership' | 'unassignActiveDefinitionsForMembership'
>;

/**
 * Unassigns OPEN TaskInstances and active TaskDefinitions for the exact
 * ending Membership tenure. Uses `endedAt` as `updated_at`. Never rewrites
 * creatorMembershipId or historical COMPLETED/deactivated assignment.
 */
export function createMembershipEndingTaskCleanup(
  tasks: MembershipEndingTaskCleanupTasks,
): MembershipEndingTaskCleanup {
  return Object.freeze({
    async handleMembershipEnded(tx, input) {
      const assignment = Object.freeze({
        homeId: input.homeId,
        membershipId: input.membershipId,
        updatedAt: input.endedAt,
      });
      await tasks.unassignOpenTasksForMembership(tx, assignment);
      await tasks.unassignActiveDefinitionsForMembership(tx, assignment);
    },
  });
}

export function createMembershipEndingTaskCleanupFromPool(
  pool: TransactionPool,
): MembershipEndingTaskCleanup {
  return createMembershipEndingTaskCleanup(
    createTaskRepository(pool as Parameters<typeof createTaskRepository>[0]),
  );
}
