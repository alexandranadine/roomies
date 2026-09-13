import { AuthorizationIntegrityError } from '../../platform/authz/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';

/**
 * Public Home/Membership query seam for exact active tenure assignment.
 * Looks up Membership.id in the requested Home. Never accepts User.id.
 * Unknown, ended, archived-Home, and cross-Home IDs all return null.
 */
export type ActiveHomeMembership = Readonly<{
  id: string;
  homeId: string;
}>;

export type ActiveHomeMembershipLookup = (
  tx: TransactionContext,
  input: { homeId: string; membershipId: string },
) => Promise<ActiveHomeMembership | null>;

export const FIND_ACTIVE_HOME_MEMBERSHIP_SQL = `
SELECT
  m.id,
  m.home_id
FROM memberships AS m
JOIN homes AS h
  ON h.id = m.home_id
WHERE m.id = $1
  AND m.home_id = $2
  AND m.ended_at IS NULL
  AND h.archived_at IS NULL
LIMIT 2
`;

type ActiveHomeMembershipRow = {
  id: unknown;
  home_id: unknown;
};

function logIntegrityFailure(kind: 'lookup' | 'rows' | 'scope'): void {
  console.error('[memberships] active tenure lookup integrity failure', {
    errorClass: kind,
  });
}

export async function findActiveHomeMembership(
  tx: TransactionContext,
  input: { homeId: string; membershipId: string },
): Promise<ActiveHomeMembership | null> {
  let rows: ActiveHomeMembershipRow[];
  try {
    const result = await tx.query<ActiveHomeMembershipRow>(
      FIND_ACTIVE_HOME_MEMBERSHIP_SQL,
      [input.membershipId, input.homeId],
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
    typeof row.home_id !== 'string'
  ) {
    logIntegrityFailure('rows');
    throw new AuthorizationIntegrityError();
  }

  if (row.id !== input.membershipId || row.home_id !== input.homeId) {
    logIntegrityFailure('scope');
    throw new AuthorizationIntegrityError();
  }

  return Object.freeze({
    id: row.id,
    homeId: row.home_id,
  });
}
