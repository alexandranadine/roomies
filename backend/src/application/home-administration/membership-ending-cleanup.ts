import type { MembershipEndedCause } from '../../domains/memberships/events.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';

/**
 * Shared cleanup arguments for owning modules. Exact tenure only — never a
 * userId substitute. The same TransactionContext and timestamp must be used
 * for Task cleanup, Supply cleanup, Membership ending, and outbox.
 */
export type MembershipEndingCleanupInput = Readonly<{
  homeId: string;
  membershipId: string;
  endedAt: Date;
  cause: MembershipEndedCause;
}>;

/**
 * Public Task-module port for synchronous membership-ending consequences.
 * Tasks implements this via createMembershipEndingTaskCleanup.
 */
export type MembershipEndingTaskCleanup = {
  handleMembershipEnded(
    tx: TransactionContext,
    input: MembershipEndingCleanupInput,
  ): Promise<void>;
};

/**
 * Public Supply-module port for synchronous membership-ending consequences.
 * M4 Supplies will replace the temporary no-op adapter that implements this.
 */
export type MembershipEndingSupplyCleanup = {
  handleMembershipEnded(
    tx: TransactionContext,
    input: MembershipEndingCleanupInput,
  ): Promise<void>;
};
