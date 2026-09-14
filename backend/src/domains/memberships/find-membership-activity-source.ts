import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { MembershipActivitySourceIntegrityError } from './errors.js';

/**
 * Public Activity-safe canonical Membership start projection. No identity,
 * display, or ended-tenure fields.
 */
export type MembershipStartedActivitySource = Readonly<{
  membershipId: string;
  homeId: string;
  joinedAt: Date;
}>;

/**
 * Public Activity-safe canonical Membership end projection. No identity,
 * display, or unrelated tenure fields.
 */
export type MembershipEndedActivitySource = Readonly<{
  membershipId: string;
  homeId: string;
  endedAt: Date | null;
  endedByMembershipId: string | null;
}>;

/**
 * Public Activity-safe canonical Membership role-transition projection.
 * Identifies one immutable transition. No current or historical snapshots.
 */
export type MembershipRoleTransitionActivitySource = Readonly<{
  transitionId: string;
  homeId: string;
  membershipId: string;
  actorMembershipId: string;
  changedAt: Date;
}>;

export type FindMembershipStartedActivitySourceInput = Readonly<{
  membershipId: string;
  expectedHomeId: string;
}>;

export type FindMembershipEndedActivitySourceInput = Readonly<{
  membershipId: string;
  expectedHomeId: string;
}>;

export type FindMembershipRoleTransitionActivitySourceInput = Readonly<{
  roleTransitionId: string;
  membershipId: string;
  expectedHomeId: string;
}>;

export type FindMembershipStartedActivitySource = (
  tx: TransactionContext,
  input: FindMembershipStartedActivitySourceInput,
) => Promise<MembershipStartedActivitySource | null>;

export type FindMembershipEndedActivitySource = (
  tx: TransactionContext,
  input: FindMembershipEndedActivitySourceInput,
) => Promise<MembershipEndedActivitySource | null>;

export type FindMembershipRoleTransitionActivitySource = (
  tx: TransactionContext,
  input: FindMembershipRoleTransitionActivitySourceInput,
) => Promise<MembershipRoleTransitionActivitySource | null>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const FIND_MEMBERSHIP_STARTED_ACTIVITY_SOURCE_SQL = `
SELECT
  m.id,
  m.home_id,
  m.joined_at
FROM memberships m
WHERE m.id = $1::uuid
LIMIT 2
`;

export const FIND_MEMBERSHIP_ENDED_ACTIVITY_SOURCE_SQL = `
SELECT
  m.id,
  m.home_id,
  m.ended_at,
  m.ended_by_membership_id
FROM memberships m
WHERE m.id = $1::uuid
LIMIT 2
`;

export const FIND_MEMBERSHIP_ROLE_TRANSITION_ACTIVITY_SOURCE_SQL = `
SELECT
  t.id,
  t.home_id,
  t.membership_id,
  t.actor_membership_id,
  t.changed_at
FROM membership_role_transitions t
WHERE t.id = $1::uuid
LIMIT 2
`;

type StartedRow = {
  id: unknown;
  home_id: unknown;
  joined_at: unknown;
};

type EndedRow = {
  id: unknown;
  home_id: unknown;
  ended_at: unknown;
  ended_by_membership_id: unknown;
};

type TransitionRow = {
  id: unknown;
  home_id: unknown;
  membership_id: unknown;
  actor_membership_id: unknown;
  changed_at: unknown;
};

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.valueOf());
}

function optionalUuid(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (isUuid(value)) {
    return value;
  }
  throw new MembershipActivitySourceIntegrityError();
}

function optionalDate(value: unknown): Date | null {
  if (value === null) {
    return null;
  }
  if (isDate(value)) {
    return value;
  }
  throw new MembershipActivitySourceIntegrityError();
}

function oneRow<T>(rows: readonly T[]): T | null {
  if (rows.length === 0) {
    return null;
  }
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new MembershipActivitySourceIntegrityError();
  }
  return rows[0];
}

async function querySourceRows<T>(
  tx: TransactionContext,
  sql: string,
  values: readonly unknown[],
): Promise<T[]> {
  try {
    const result = await tx.query<T>(sql, [...values]);
    return result.rows;
  } catch (error) {
    if (error instanceof MembershipActivitySourceIntegrityError) {
      throw error;
    }
    throw new MembershipActivitySourceIntegrityError();
  }
}

function parseStartedRow(row: StartedRow): MembershipStartedActivitySource {
  if (!isUuid(row.id) || !isUuid(row.home_id) || !isDate(row.joined_at)) {
    throw new MembershipActivitySourceIntegrityError();
  }

  return Object.freeze({
    membershipId: row.id,
    homeId: row.home_id,
    joinedAt: row.joined_at,
  });
}

function parseEndedRow(row: EndedRow): MembershipEndedActivitySource {
  if (!isUuid(row.id) || !isUuid(row.home_id)) {
    throw new MembershipActivitySourceIntegrityError();
  }

  return Object.freeze({
    membershipId: row.id,
    homeId: row.home_id,
    endedAt: optionalDate(row.ended_at),
    endedByMembershipId: optionalUuid(row.ended_by_membership_id),
  });
}

function parseTransitionRow(
  row: TransitionRow,
): MembershipRoleTransitionActivitySource {
  if (
    !isUuid(row.id) ||
    !isUuid(row.home_id) ||
    !isUuid(row.membership_id) ||
    !isUuid(row.actor_membership_id) ||
    !isDate(row.changed_at)
  ) {
    throw new MembershipActivitySourceIntegrityError();
  }

  return Object.freeze({
    transitionId: row.id,
    homeId: row.home_id,
    membershipId: row.membership_id,
    actorMembershipId: row.actor_membership_id,
    changedAt: row.changed_at,
  });
}

/**
 * Loads the Activity-safe canonical Membership start row inside the caller's
 * transaction. Missing source is null. Home mismatch is an integrity failure.
 * Never selects identity or display columns.
 */
export async function findMembershipStartedActivitySource(
  tx: TransactionContext,
  input: FindMembershipStartedActivitySourceInput,
): Promise<MembershipStartedActivitySource | null> {
  if (!isUuid(input.membershipId) || !isUuid(input.expectedHomeId)) {
    throw new MembershipActivitySourceIntegrityError();
  }

  const row = oneRow(
    await querySourceRows<StartedRow>(
      tx,
      FIND_MEMBERSHIP_STARTED_ACTIVITY_SOURCE_SQL,
      [input.membershipId],
    ),
  );
  if (row === null) {
    return null;
  }

  const parsed = parseStartedRow(row);
  if (parsed.homeId !== input.expectedHomeId) {
    throw new MembershipActivitySourceIntegrityError();
  }

  return parsed;
}

/**
 * Loads the Activity-safe canonical Membership end row inside the caller's
 * transaction. Missing source is null. Home mismatch is an integrity failure.
 * Never selects identity or display columns.
 */
export async function findMembershipEndedActivitySource(
  tx: TransactionContext,
  input: FindMembershipEndedActivitySourceInput,
): Promise<MembershipEndedActivitySource | null> {
  if (!isUuid(input.membershipId) || !isUuid(input.expectedHomeId)) {
    throw new MembershipActivitySourceIntegrityError();
  }

  const row = oneRow(
    await querySourceRows<EndedRow>(
      tx,
      FIND_MEMBERSHIP_ENDED_ACTIVITY_SOURCE_SQL,
      [input.membershipId],
    ),
  );
  if (row === null) {
    return null;
  }

  const parsed = parseEndedRow(row);
  if (parsed.homeId !== input.expectedHomeId) {
    throw new MembershipActivitySourceIntegrityError();
  }

  return parsed;
}

/**
 * Loads the exact immutable MembershipRoleTransition inside the caller's
 * transaction. Missing/erased transition is null. Home or subject mismatch on
 * an existing transition is an integrity failure. Never selects snapshots.
 */
export async function findMembershipRoleTransitionActivitySource(
  tx: TransactionContext,
  input: FindMembershipRoleTransitionActivitySourceInput,
): Promise<MembershipRoleTransitionActivitySource | null> {
  if (
    !isUuid(input.roleTransitionId) ||
    !isUuid(input.membershipId) ||
    !isUuid(input.expectedHomeId)
  ) {
    throw new MembershipActivitySourceIntegrityError();
  }

  const row = oneRow(
    await querySourceRows<TransitionRow>(
      tx,
      FIND_MEMBERSHIP_ROLE_TRANSITION_ACTIVITY_SOURCE_SQL,
      [input.roleTransitionId],
    ),
  );
  if (row === null) {
    return null;
  }

  const parsed = parseTransitionRow(row);
  if (
    parsed.homeId !== input.expectedHomeId ||
    parsed.membershipId !== input.membershipId
  ) {
    throw new MembershipActivitySourceIntegrityError();
  }

  return parsed;
}
