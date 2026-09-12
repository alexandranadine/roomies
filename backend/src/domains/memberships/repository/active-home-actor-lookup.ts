import type { Pool } from 'pg';
import {
  AuthorizationIntegrityError,
  isMembershipRole,
  type ActiveHomeActor,
} from '../../../platform/authz/index.js';

/**
 * One Home-scoped active-tenure lookup. LIMIT 2 detects an impossible
 * second active row without fetching an unbounded Membership set.
 */
export const ACTIVE_HOME_ACTOR_LOOKUP_SQL = `
SELECT
  m.id,
  m.user_id,
  m.home_id,
  m.role
FROM memberships AS m
JOIN homes AS h
  ON h.id = m.home_id
WHERE m.user_id = $1
  AND m.home_id = $2
  AND m.ended_at IS NULL
  AND h.archived_at IS NULL
LIMIT 2
`;

type ActiveMembershipRow = {
  id: unknown;
  user_id: unknown;
  home_id: unknown;
  role: unknown;
};

function logIntegrityFailure(kind: 'lookup' | 'role' | 'rows' | 'scope'): void {
  console.error('[authz] authorization integrity failure', {
    errorClass: kind,
  });
}

export async function lookupActiveHomeActor(
  pool: Pool,
  input: { userId: string; homeId: string },
): Promise<ActiveHomeActor | null> {
  let rows: ActiveMembershipRow[];
  try {
    const result = await pool.query<ActiveMembershipRow>(
      ACTIVE_HOME_ACTOR_LOOKUP_SQL,
      [input.userId, input.homeId],
    );
    rows = result.rows;
  } catch {
    logIntegrityFailure('lookup');
    throw new AuthorizationIntegrityError();
  }

  if (rows.length === 0) {
    return null;
  }

  if (rows.length !== 1) {
    logIntegrityFailure('rows');
    throw new AuthorizationIntegrityError();
  }

  const row = rows[0];
  if (
    row === undefined ||
    typeof row.id !== 'string' ||
    typeof row.user_id !== 'string' ||
    typeof row.home_id !== 'string'
  ) {
    logIntegrityFailure('rows');
    throw new AuthorizationIntegrityError();
  }

  if (row.user_id !== input.userId || row.home_id !== input.homeId) {
    logIntegrityFailure('scope');
    throw new AuthorizationIntegrityError();
  }

  if (!isMembershipRole(row.role)) {
    logIntegrityFailure('role');
    throw new AuthorizationIntegrityError();
  }

  return Object.freeze({
    userId: row.user_id,
    membershipId: row.id,
    homeId: row.home_id,
    role: row.role,
  });
}
