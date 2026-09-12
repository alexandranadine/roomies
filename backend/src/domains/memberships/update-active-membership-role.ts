import { TransactionInfrastructureError } from '../../platform/persistence/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import type { MembershipRole } from '../../platform/authz/context.js';

/**
 * Defensively scoped tenure UPDATE. Role only; same membershipId / user /
 * home / joined_at. Callers treat unexpected zero rows as integrity failure.
 */
export const UPDATE_ACTIVE_MEMBERSHIP_ROLE_SQL = `
UPDATE memberships
SET role = $1
WHERE id = $2
  AND home_id = $3
  AND ended_at IS NULL
  AND role = $4
`;

export type MembershipRoleWriter = {
  updateActiveRole(
    tx: TransactionContext,
    input: {
      membershipId: string;
      homeId: string;
      previousRole: MembershipRole;
      newRole: MembershipRole;
    },
  ): Promise<number>;
};

export function createMembershipRoleWriter(): MembershipRoleWriter {
  return Object.freeze({
    async updateActiveRole(tx, input) {
      let result: { rowCount: number | null };
      try {
        result = await tx.query(UPDATE_ACTIVE_MEMBERSHIP_ROLE_SQL, [
          input.newRole,
          input.membershipId,
          input.homeId,
          input.previousRole,
        ]);
      } catch {
        throw new TransactionInfrastructureError();
      }
      return result.rowCount ?? 0;
    },
  });
}
