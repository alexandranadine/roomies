import { AuthorizationIntegrityError } from '../../platform/authz/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';

/**
 * Public same-Home active Membership validation seam.
 *
 * Given a locked Home id and an exact Membership.id set, returns only the
 * active Membership IDs that currently belong to that Home. Identity is
 * exact Membership.id. No User lookup, capability expansion, foreign Home
 * details, or per-ID failure reason.
 */
export type FindActiveExactMembershipIdsInHomeInput = Readonly<{
  homeId: string;
  membershipIds: readonly string[];
}>;

export type FindActiveExactMembershipIdsInHome = (
  tx: TransactionContext,
  input: FindActiveExactMembershipIdsInHomeInput,
) => Promise<readonly string[]>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const FIND_ACTIVE_EXACT_MEMBERSHIP_IDS_IN_HOME_SQL = `
SELECT m.id
FROM memberships AS m
WHERE m.home_id = $1::uuid
  AND m.id = ANY($2::uuid[])
  AND m.ended_at IS NULL
ORDER BY m.id ASC
`;

type ActiveMembershipIdRow = {
  id: unknown;
};

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function logIntegrityFailure(kind: 'lookup' | 'rows' | 'scope'): void {
  console.error(
    '[memberships] same-Home active Membership validation integrity failure',
    { errorClass: kind },
  );
}

function uniqueSortedMembershipIds(
  membershipIds: readonly string[],
): readonly string[] {
  const unique = new Set<string>();
  for (const membershipId of membershipIds) {
    if (!isUuid(membershipId)) {
      logIntegrityFailure('scope');
      throw new AuthorizationIntegrityError();
    }
    unique.add(membershipId);
  }
  return Object.freeze(
    [...unique].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

/**
 * Read-only exact-ID filter. Caller already holds the Home lock. Does not
 * lock Membership rows and does not distinguish missing, ended, or foreign.
 */
export async function findActiveExactMembershipIdsInHome(
  tx: TransactionContext,
  input: FindActiveExactMembershipIdsInHomeInput,
): Promise<readonly string[]> {
  if (!isUuid(input.homeId)) {
    logIntegrityFailure('scope');
    throw new AuthorizationIntegrityError();
  }

  const requested = uniqueSortedMembershipIds(input.membershipIds);
  if (requested.length === 0) {
    return Object.freeze([]);
  }

  const requestedSet = new Set(requested);
  let rows: ActiveMembershipIdRow[];
  try {
    const result = await tx.query<ActiveMembershipIdRow>(
      FIND_ACTIVE_EXACT_MEMBERSHIP_IDS_IN_HOME_SQL,
      [input.homeId, requested],
    );
    rows = result.rows;
  } catch {
    logIntegrityFailure('lookup');
    throw new AuthorizationIntegrityError();
  }

  const found: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isUuid(row.id) || !requestedSet.has(row.id) || seen.has(row.id)) {
      logIntegrityFailure('rows');
      throw new AuthorizationIntegrityError();
    }
    seen.add(row.id);
    found.push(row.id);
  }

  return Object.freeze(
    found.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}
