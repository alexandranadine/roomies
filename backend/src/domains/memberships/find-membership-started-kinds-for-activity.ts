import { MembershipActivitySourceIntegrityError } from './errors.js';

export const MEMBERSHIP_STARTED_KINDS = ['HOME_CREATION', 'JOINED'] as const;

export type MembershipStartedKind =
  (typeof MEMBERSHIP_STARTED_KINDS)[number];

export type FindMembershipStartedKindsForActivityInput = Readonly<{
  homeId: string;
  membershipIds: readonly string[];
}>;

export type MembershipStartedKindQueryable = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: T[] }>;
};

export type FindMembershipStartedKindsForActivity = (
  db: MembershipStartedKindQueryable,
  input: FindMembershipStartedKindsForActivityInput,
) => Promise<ReadonlyMap<string, MembershipStartedKind>>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const FIND_MEMBERSHIP_STARTED_KINDS_FOR_ACTIVITY_SQL = `
SELECT
  m.id AS membership_id,
  (m.joined_at = h.created_at) AS created_home
FROM memberships AS m
INNER JOIN homes AS h
  ON h.id = m.home_id
WHERE m.home_id = $1::uuid
  AND m.id = ANY($2::uuid[])
`;

type KindRow = {
  membership_id: unknown;
  created_home: unknown;
};

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function parseKindRow(row: KindRow): {
  membershipId: string;
  kind: MembershipStartedKind;
} {
  if (!isUuid(row.membership_id)) {
    throw new MembershipActivitySourceIntegrityError();
  }
  if (row.created_home === true) {
    return { membershipId: row.membership_id, kind: 'HOME_CREATION' };
  }
  if (row.created_home === false) {
    return { membershipId: row.membership_id, kind: 'JOINED' };
  }
  throw new MembershipActivitySourceIntegrityError();
}

/**
 * Resolves whether each Membership start was Home creation or a later join.
 * Uses canonical joined_at and home created_at only — no identity or role fields.
 */
export async function findMembershipStartedKindsForActivity(
  db: MembershipStartedKindQueryable,
  input: FindMembershipStartedKindsForActivityInput,
): Promise<ReadonlyMap<string, MembershipStartedKind>> {
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

  let rows: KindRow[];
  try {
    const result = await db.query<KindRow>(
      FIND_MEMBERSHIP_STARTED_KINDS_FOR_ACTIVITY_SQL,
      [input.homeId, [...unique]],
    );
    rows = result.rows;
  } catch (error) {
    if (error instanceof MembershipActivitySourceIntegrityError) {
      throw error;
    }
    throw new MembershipActivitySourceIntegrityError();
  }

  const kinds = new Map<string, MembershipStartedKind>();
  for (const row of rows) {
    const parsed = parseKindRow(row);
    if (kinds.has(parsed.membershipId)) {
      throw new MembershipActivitySourceIntegrityError();
    }
    kinds.set(parsed.membershipId, parsed.kind);
  }

  if (kinds.size !== unique.size) {
    throw new MembershipActivitySourceIntegrityError();
  }

  return kinds;
}
