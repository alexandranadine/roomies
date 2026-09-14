import { TransactionInfrastructureError } from '../../platform/persistence/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';

/**
 * Immutable role-transition insert. Application supplies the UUIDv7 id.
 * No oldRole/newRole, userId, or display columns.
 */
export const INSERT_MEMBERSHIP_ROLE_TRANSITION_SQL = `
INSERT INTO membership_role_transitions (
  id,
  home_id,
  membership_id,
  actor_membership_id,
  changed_at,
  created_at
)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz, $6::timestamptz)
`;

export type NewMembershipRoleTransition = Readonly<{
  id: string;
  homeId: string;
  membershipId: string;
  actorMembershipId: string;
  changedAt: Date;
  createdAt: Date;
}>;

export type MembershipRoleTransitionWriter = {
  insertTransition(
    tx: TransactionContext,
    input: NewMembershipRoleTransition,
  ): Promise<number>;
};

export function createMembershipRoleTransitionWriter(): MembershipRoleTransitionWriter {
  return Object.freeze({
    async insertTransition(tx, input) {
      let result: { rowCount: number | null };
      try {
        result = await tx.query(INSERT_MEMBERSHIP_ROLE_TRANSITION_SQL, [
          input.id,
          input.homeId,
          input.membershipId,
          input.actorMembershipId,
          input.changedAt,
          input.createdAt,
        ]);
      } catch {
        throw new TransactionInfrastructureError();
      }
      return result.rowCount ?? 0;
    },
  });
}
