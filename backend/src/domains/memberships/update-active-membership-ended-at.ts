import { TransactionInfrastructureError } from '../../platform/persistence/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';

/**
 * Defensively scoped tenure UPDATE. ended_at only; same membershipId / home /
 * joined_at / role. Callers treat unexpected zero rows as integrity failure.
 */
export const UPDATE_ACTIVE_MEMBERSHIP_ENDED_AT_SQL = `
UPDATE memberships
SET ended_at = $1
WHERE id = $2
  AND home_id = $3
  AND ended_at IS NULL
`;

export type MembershipEndingWriter = {
  endActiveMembership(
    tx: TransactionContext,
    input: {
      membershipId: string;
      homeId: string;
      endedAt: Date;
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
