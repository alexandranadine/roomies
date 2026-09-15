import { TransactionInfrastructureError } from '../../platform/persistence/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';

/**
 * Read-only discovery of every Membership tenure for one canonical User.
 * Includes active, ended, rejoin, and multi-Home rows. Does not lock.
 * Callers must already hold the canonical User row so no new tenure can
 * appear for this User before later Home/Membership locks.
 */
export const LIST_USER_MEMBERSHIP_TENURES_SQL = `
SELECT id, home_id, ended_at
FROM memberships
WHERE user_id = $1::uuid
ORDER BY home_id ASC, id ASC
`;

export type UserMembershipTenure = Readonly<{
  membershipId: string;
  homeId: string;
  endedAt: Date | null;
}>;

export type ListUserMembershipTenures = (
  tx: TransactionContext,
  userId: string,
) => Promise<readonly UserMembershipTenure[]>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type TenureRow = {
  id: unknown;
  home_id: unknown;
  ended_at: unknown;
};

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isDateOrNull(value: unknown): value is Date | null {
  return (
    value === null || (value instanceof Date && !Number.isNaN(value.valueOf()))
  );
}

function logIntegrityFailure(kind: 'scope' | 'rows'): void {
  console.error('[memberships] user tenure discovery integrity failure', {
    errorClass: kind,
  });
}

export class MembershipTenureDiscoveryIntegrityError extends Error {
  override readonly name = 'MembershipTenureDiscoveryIntegrityError';

  constructor() {
    super('Membership tenure discovery integrity failure');
  }
}

function parseTenure(row: TenureRow): UserMembershipTenure {
  if (!isUuid(row.id) || !isUuid(row.home_id) || !isDateOrNull(row.ended_at)) {
    logIntegrityFailure('rows');
    throw new MembershipTenureDiscoveryIntegrityError();
  }

  return Object.freeze({
    membershipId: row.id,
    homeId: row.home_id,
    endedAt: row.ended_at,
  });
}

/**
 * Lists all historical and active Membership IDs for the supplied User.
 * Does not collapse rejoin tenures. Does not substitute the current
 * Membership for the historical set. Empty result is success.
 */
export async function listUserMembershipTenures(
  tx: TransactionContext,
  userId: string,
): Promise<readonly UserMembershipTenure[]> {
  if (!isUuid(userId)) {
    logIntegrityFailure('scope');
    throw new MembershipTenureDiscoveryIntegrityError();
  }

  let rows: TenureRow[];
  try {
    const result = await tx.query<TenureRow>(LIST_USER_MEMBERSHIP_TENURES_SQL, [
      userId,
    ]);
    rows = result.rows;
  } catch (error) {
    if (error instanceof MembershipTenureDiscoveryIntegrityError) {
      throw error;
    }
    throw new TransactionInfrastructureError();
  }

  const seen = new Set<string>();
  const tenures: UserMembershipTenure[] = [];
  for (const row of rows) {
    const tenure = parseTenure(row);
    if (seen.has(tenure.membershipId)) {
      logIntegrityFailure('rows');
      throw new MembershipTenureDiscoveryIntegrityError();
    }
    seen.add(tenure.membershipId);
    tenures.push(tenure);
  }

  return Object.freeze(tenures);
}
