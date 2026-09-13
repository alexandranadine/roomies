import type { MembershipRole } from '../../platform/authz/context.js';
import { TransactionInfrastructureError } from '../../platform/persistence/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';

export type NewActiveMembership = Readonly<{
  id: string;
  homeId: string;
  userId: string;
  role: MembershipRole;
  joinedAt: Date;
}>;

export const INSERT_ACTIVE_MEMBERSHIP_SQL = `
INSERT INTO memberships (id, home_id, user_id, role, joined_at, ended_at)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, NULL)
`;

/**
 * Ordinary active Membership insert. Role is caller-supplied; Home creation
 * always passes ADMIN. This is not a privileged permanent tenure type.
 */
export async function insertActiveMembership(
  tx: TransactionContext,
  membership: NewActiveMembership,
): Promise<void> {
  try {
    const result = await tx.query(INSERT_ACTIVE_MEMBERSHIP_SQL, [
      membership.id,
      membership.homeId,
      membership.userId,
      membership.role,
      membership.joinedAt,
    ]);
    if (result.rowCount !== 1) {
      throw new TransactionInfrastructureError();
    }
  } catch (error) {
    if (error instanceof TransactionInfrastructureError) {
      throw error;
    }
    throw new TransactionInfrastructureError();
  }
}
