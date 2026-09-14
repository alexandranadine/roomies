import { TransactionInfrastructureError } from '../../platform/persistence/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';

/**
 * Defensively scoped tenure UPDATE. ended_at and ended_by_membership_id
 * together; same membershipId / home / joined_at / role. Never a userId.
 * Callers treat unexpected zero rows as integrity failure.
 */
export const UPDATE_ACTIVE_MEMBERSHIP_ENDED_AT_SQL = `
UPDATE memberships
SET ended_at = $1,
    ended_by_membership_id = $2
WHERE id = $3
  AND home_id = $4
  AND ended_at IS NULL
  AND ended_by_membership_id IS NULL
`;

export type MembershipEndingWriter = {
  endActiveMembership(
    tx: TransactionContext,
    input: {
      membershipId: string;
      homeId: string;
      endedAt: Date;
      endedByMembershipId: string;
    },
  ): Promise<number>;
};

export function createMembershipEndingWriter(): MembershipEndingWriter {
  return Object.freeze({
    async endActiveMembership(tx, input) {
      let result: { rowCount: number | null };
      try {
        result = await tx.query(UPDATE_ACTIVE_MEMBERSHIP_ENDED_AT_SQL, [
          input.endedAt,
          input.endedByMembershipId,
          input.membershipId,
          input.homeId,
        ]);
      } catch {
        throw new TransactionInfrastructureError();
      }
      return result.rowCount ?? 0;
    },
  });
}
