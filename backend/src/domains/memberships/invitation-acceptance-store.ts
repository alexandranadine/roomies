import type { TransactionContext } from '../../platform/persistence/transaction.js';

export type PriorMembershipTenure = Readonly<{
  id: string;
  role: 'ROOMMATE' | 'ADMIN';
  joinedAt: Date;
  endedAt: Date;
}>;

export type NewInvitationMembership = Readonly<{
  id: string;
  homeId: string;
  userId: string;
  joinedAt: Date;
}>;

export class MembershipAcceptancePersistenceError extends Error {
  override readonly name = 'MembershipAcceptancePersistenceError';

  constructor() {
    super('Membership acceptance persistence failed');
  }
}

export class ActiveMembershipConflictError extends Error {
  override readonly name = 'ActiveMembershipConflictError';

  constructor() {
    super('An active Membership already exists');
  }
}

type PriorMembershipRow = {
  id: unknown;
  role: unknown;
  joined_at: unknown;
  ended_at: unknown;
};

function hasConstraint(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === constraint
  );
}

/**
 * Reads immutable ended tenure history after the Home structural mutex is
 * held. Ended rows need no additional row lock because all tenure-ending
 * structural mutations are serialized through that Home.
 */
export async function findLatestEndedMembershipTenure(
  tx: TransactionContext,
  input: { homeId: string; userId: string },
): Promise<PriorMembershipTenure | null> {
  let rows: PriorMembershipRow[];
  try {
    rows = (
      await tx.query<PriorMembershipRow>(
        `SELECT id, role, joined_at, ended_at
         FROM memberships
         WHERE home_id = $1::uuid
           AND user_id = $2::uuid
           AND ended_at IS NOT NULL
         ORDER BY ended_at DESC, id DESC
         LIMIT 1`,
        [input.homeId, input.userId],
      )
    ).rows;
  } catch {
    throw new MembershipAcceptancePersistenceError();
  }

  if (rows.length === 0) {
    return null;
  }
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row === undefined ||
    typeof row.id !== 'string' ||
    (row.role !== 'ROOMMATE' && row.role !== 'ADMIN') ||
    !(row.joined_at instanceof Date) ||
    Number.isNaN(row.joined_at.valueOf()) ||
    !(row.ended_at instanceof Date) ||
    Number.isNaN(row.ended_at.valueOf())
  ) {
    throw new MembershipAcceptancePersistenceError();
  }

  return Object.freeze({
    id: row.id,
    role: row.role,
    joinedAt: row.joined_at,
    endedAt: row.ended_at,
  });
}

/** Inserts a fresh ROOMMATE tenure; no historical row can be reopened here. */
export async function insertInvitationMembership(
  tx: TransactionContext,
  membership: NewInvitationMembership,
): Promise<void> {
  try {
    const result = await tx.query(
      `INSERT INTO memberships (id, home_id, user_id, role, joined_at, ended_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'ROOMMATE', $4::timestamptz, NULL)`,
      [
        membership.id,
        membership.homeId,
        membership.userId,
        membership.joinedAt,
      ],
    );
    if (result.rowCount !== 1) {
      throw new MembershipAcceptancePersistenceError();
    }
  } catch (error) {
    if (hasConstraint(error, 'memberships_one_active_per_home_user_4b7d5c14')) {
      throw new ActiveMembershipConflictError();
    }
    if (error instanceof MembershipAcceptancePersistenceError) {
      throw error;
    }
    throw new MembershipAcceptancePersistenceError();
  }
}
