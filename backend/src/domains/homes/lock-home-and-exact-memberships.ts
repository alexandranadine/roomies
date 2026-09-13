import type { MembershipRole } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  isMembershipRole,
} from '../../platform/authz/index.js';
import { TransactionInfrastructureError } from '../../platform/persistence/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { LOCK_HOME_FOR_UPDATE_SQL } from './lock-home-structure.js';
import { StructuralIntegrityError } from './structure-errors.js';

/**
 * Exact Home + exact Membership lock seam for content mutations.
 *
 * Frozen lock order: Home → Membership. Never lock Membership first.
 *
 * Home lock mode: SELECT ... FOR UPDATE (LOCK_HOME_FOR_UPDATE_SQL).
 * Home archival (`UPDATE homes SET archived_at`) is a non-key UPDATE, so
 * PostgreSQL takes FOR NO KEY UPDATE on that row. FOR UPDATE conflicts with
 * FOR NO KEY UPDATE and therefore blocks archival. FOR KEY SHARE would not.
 * The same FOR UPDATE also conflicts with lockHomeStructure's Home lock.
 *
 * Membership lock mode: SELECT ... FOR UPDATE on each requested tenure id.
 * Membership ending (`UPDATE memberships SET ended_at`) is a non-key UPDATE
 * and takes FOR NO KEY UPDATE. FOR UPDATE conflicts with that UPDATE.
 * FOR KEY SHARE would not block ending. Rows are locked one-by-one in
 * ascending Membership id order so actor and assignee never deadlock.
 */
export const LOCK_EXACT_MEMBERSHIP_FOR_UPDATE_SQL = `
SELECT id, user_id, home_id, role, ended_at
FROM memberships
WHERE id = $1
FOR UPDATE
`;

export type ExactLockedMembership = Readonly<{
  id: string;
  userId: string;
  homeId: string;
  role: MembershipRole;
  endedAt: Date | null;
}>;

export type LockedHomeAndExactMemberships = Readonly<{
  home: Readonly<{
    id: string;
    archivedAt: Date | null;
  }>;
  memberships: readonly ExactLockedMembership[];
}>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type HomeLockRow = {
  id: unknown;
  archived_at: unknown;
};

type MembershipLockRow = {
  id: unknown;
  user_id: unknown;
  home_id: unknown;
  role: unknown;
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

function logStructuralFailure(kind: 'home' | 'rows'): void {
  console.error('[homes] exact membership lock integrity failure', {
    errorClass: kind,
  });
}

export function uniqueSortedMembershipIds(
  membershipIds: readonly string[],
): readonly string[] {
  return Object.freeze([...new Set(membershipIds)].sort());
}

function parseLockedMembership(row: MembershipLockRow): ExactLockedMembership {
  if (
    !isUuid(row.id) ||
    !isUuid(row.user_id) ||
    !isUuid(row.home_id) ||
    !isMembershipRole(row.role) ||
    !isDateOrNull(row.ended_at)
  ) {
    logStructuralFailure('rows');
    throw new StructuralIntegrityError();
  }

  return Object.freeze({
    id: row.id,
    userId: row.user_id,
    homeId: row.home_id,
    role: row.role,
    endedAt: row.ended_at,
  });
}

/**
 * Lock the exact Home, refuse an archived Home, then lock the exact
 * Membership rows in deterministic id order.
 */
export async function lockHomeAndExactMemberships(
  tx: TransactionContext,
  input: {
    homeId: string;
    membershipIds: readonly string[];
  },
): Promise<LockedHomeAndExactMemberships> {
  let homeRows: HomeLockRow[];
  try {
    const result = await tx.query<HomeLockRow>(LOCK_HOME_FOR_UPDATE_SQL, [
      input.homeId,
    ]);
    homeRows = result.rows;
  } catch {
    throw new TransactionInfrastructureError();
  }

  const homeRow = homeRows[0];
  if (homeRows.length > 1) {
    logStructuralFailure('home');
    throw new StructuralIntegrityError();
  }
  if (homeRows.length === 0 || homeRow === undefined) {
    throw new ConcealedNotFoundError();
  }

  if (
    !isUuid(homeRow.id) ||
    homeRow.id !== input.homeId ||
    !isDateOrNull(homeRow.archived_at)
  ) {
    logStructuralFailure('home');
    throw new StructuralIntegrityError();
  }

  if (homeRow.archived_at !== null) {
    throw new ConcealedNotFoundError();
  }

  const orderedIds = uniqueSortedMembershipIds(input.membershipIds);
  const memberships: ExactLockedMembership[] = [];

  for (const membershipId of orderedIds) {
    let membershipRows: MembershipLockRow[];
    try {
      const result = await tx.query<MembershipLockRow>(
        LOCK_EXACT_MEMBERSHIP_FOR_UPDATE_SQL,
        [membershipId],
      );
      membershipRows = result.rows;
    } catch {
      throw new TransactionInfrastructureError();
    }

    if (membershipRows.length > 1) {
      logStructuralFailure('rows');
      throw new StructuralIntegrityError();
    }

    const membershipRow = membershipRows[0];
    if (membershipRow === undefined) {
      continue;
    }
    memberships.push(parseLockedMembership(membershipRow));
  }

  return Object.freeze({
    home: Object.freeze({
      id: homeRow.id,
      archivedAt: homeRow.archived_at,
    }),
    memberships: Object.freeze(memberships),
  });
}
