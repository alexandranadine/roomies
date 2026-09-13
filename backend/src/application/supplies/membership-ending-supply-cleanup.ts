import type { MembershipEndedCause } from '../../domains/memberships/events.js';
import {
  createSupplyRepository,
  type SupplyRepository,
} from '../../domains/supplies/repository.js';
import type {
  TransactionContext,
  TransactionPool,
} from '../../platform/persistence/transaction.js';

/**
 * Supplies-owned public seam for synchronous membership-ending cleanup.
 * Callers must already hold Home/Membership structural locks and pass the
 * existing transaction plus the shared operation timestamp.
 *
 * Does not begin, commit, or roll back a transaction. Does not emit Supply
 * events. Does not lock Home or Membership. Every Membership-ending cause
 * releases active claims with MEMBERSHIP_ENDED.
 */
export type MembershipEndingSupplyCleanupInput = Readonly<{
  homeId: string;
  membershipId: string;
  endedAt: Date;
  cause: MembershipEndedCause;
}>;

export type MembershipEndingSupplyCleanup = Readonly<{
  handleMembershipEnded(
    tx: TransactionContext,
    input: MembershipEndingSupplyCleanupInput,
  ): Promise<void>;
}>;

export type MembershipEndingSupplyCleanupSupplies = Pick<
  SupplyRepository,
  'releaseActiveClaimsForMembership'
>;

/**
 * Releases active SupplyClaims for the exact ending Membership tenure.
 * Uses `endedAt` as both `released_at` and `updated_at`. Never rewrites
 * claimantMembershipId or SupplyEntry status. Zero matching rows is success.
 */
export function createMembershipEndingSupplyCleanup(
  supplies: MembershipEndingSupplyCleanupSupplies,
): MembershipEndingSupplyCleanup {
  return Object.freeze({
    async handleMembershipEnded(tx, input) {
      await supplies.releaseActiveClaimsForMembership(tx, {
        homeId: input.homeId,
        membershipId: input.membershipId,
        releasedAt: input.endedAt,
      });
    },
  });
}

export function createMembershipEndingSupplyCleanupFromPool(
  pool: TransactionPool,
): MembershipEndingSupplyCleanup {
  return createMembershipEndingSupplyCleanup(
    createSupplyRepository(
      pool as Parameters<typeof createSupplyRepository>[0],
    ),
  );
}
