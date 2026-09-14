import { MembershipActivitySourceIntegrityError } from './errors.js';

/**
 * Safe historical Membership display. Name is AuthIdentity.name when the
 * identity still exists. Ended tenures remain eligible. No account
 * identifiers or role are returned.
 */
export type HistoricalMembershipDisplay = Readonly<{
  membershipId: string;
  name: string | null;
}>;

export type FindHistoricalMembershipDisplaysInput = Readonly<{
  homeId: string;
  membershipIds: readonly string[];
}>;

export type HistoricalMembershipDisplayQueryable = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: T[] }>;
};

export type FindHistoricalMembershipDisplays = (
  db: HistoricalMembershipDisplayQueryable,
  input: FindHistoricalMembershipDisplaysInput,
) => Promise<ReadonlyMap<string, HistoricalMembershipDisplay>>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const FIND_HISTORICAL_MEMBERSHIP_DISPLAYS_SQL = `
SELECT
  m.id AS membership_id,
  i.name AS name
FROM memberships AS m
LEFT JOIN auth_identities AS i
  ON i.id = m.user_id
WHERE m.home_id = $1::uuid
  AND m.id = ANY($2::uuid[])
`;

type DisplayRow = {
  membership_id: unknown;
  name: unknown;
};

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function logIntegrityFailure(): void {
  console.error(
    '[memberships] historical Membership display integrity failure',
    { errorClass: 'row' },
  );
}

/**
 * Loads recipient-safe historical display names for exact Membership IDs
 * in one Home. Missing identity is a null name. Missing Membership is
 * omitted from the map. Never returns user identifiers.
 */
export async function findHistoricalMembershipDisplays(
  db: HistoricalMembershipDisplayQueryable,
  input: FindHistoricalMembershipDisplaysInput,
): Promise<ReadonlyMap<string, HistoricalMembershipDisplay>> {
  if (!isUuid(input.homeId)) {
    throw new MembershipActivitySourceIntegrityError();
  }
  const unique = new Set<string>();
  for (const membershipId of input.membershipIds) {
    if (!isUuid(membershipId)) {
      throw new MembershipActivitySourceIntegrityError();
    }
    unique.add(membershipId);
  }
  if (unique.size === 0) {
    return new Map();
  }

  let rows: DisplayRow[];
  try {
    const result = await db.query<DisplayRow>(
      FIND_HISTORICAL_MEMBERSHIP_DISPLAYS_SQL,
      [input.homeId, [...unique]],
    );
    rows = result.rows;
  } catch (error) {
    if (error instanceof MembershipActivitySourceIntegrityError) {
      throw error;
    }
    throw new MembershipActivitySourceIntegrityError();
  }

  const displays = new Map<string, HistoricalMembershipDisplay>();
  for (const row of rows) {
    if (!isUuid(row.membership_id) || displays.has(row.membership_id)) {
      logIntegrityFailure();
      throw new MembershipActivitySourceIntegrityError();
    }
    if (
      row.name !== null &&
      (typeof row.name !== 'string' || row.name.length === 0)
    ) {
      logIntegrityFailure();
      throw new MembershipActivitySourceIntegrityError();
    }
    displays.set(
      row.membership_id,
      Object.freeze({
        membershipId: row.membership_id,
        name: row.name,
      }),
    );
  }
  return displays;
}
