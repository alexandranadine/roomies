import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  isMembershipRole,
} from '../../platform/authz/index.js';
import { TransactionInfrastructureError } from '../../platform/persistence/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import type {
  LockedActiveMembership,
  LockedHomeEntryStructure,
  LockedHomeStructure,
} from './locked-home-structure.js';
import { StructuralIntegrityError } from './structure-errors.js';
import { evaluateHomeStructureInvariant } from './structure-invariant.js';

/**
 * First structural query: lock the Home row. The Home row is the per-Home
 * mutex. Missing and archived Homes share the same concealed 404.
 */
export const LOCK_HOME_FOR_UPDATE_SQL = `
SELECT id, archived_at
FROM homes
WHERE id = $1
FOR UPDATE
`;

/**
 * Second structural query: lock the complete active Membership set.
 * Filtered in SQL by home_id; do not load a broader set and filter in JS.
 */
export const LOCK_ACTIVE_MEMBERSHIPS_FOR_UPDATE_SQL = `
SELECT id, user_id, home_id, role
FROM memberships
WHERE home_id = $1
  AND ended_at IS NULL
ORDER BY id
FOR UPDATE
`;

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
};

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isDateOrNull(value: unknown): value is Date | null {
  return (
    value === null || (value instanceof Date && !Number.isNaN(value.valueOf()))
  );
}

function logStructuralFailure(kind: 'home' | 'rows' | 'invariant'): void {
  console.error('[homes] structural integrity failure', {
    errorClass: kind,
  });
}

function parseLockedMembership(
  row: MembershipLockRow,
  homeId: string,
): LockedActiveMembership {
  if (
    !isUuid(row.id) ||
    !isUuid(row.user_id) ||
    !isUuid(row.home_id) ||
    row.home_id !== homeId ||
    !isMembershipRole(row.role)
  ) {
    logStructuralFailure('rows');
    throw new StructuralIntegrityError();
  }

  return Object.freeze({
    id: row.id,
    userId: row.user_id,
    homeId: row.home_id,
    role: row.role,
  });
}

function assertUniqueActiveSet(
  memberships: readonly LockedActiveMembership[],
): void {
  const ids = new Set<string>();
  const users = new Set<string>();

  for (const membership of memberships) {
    if (ids.has(membership.id) || users.has(membership.userId)) {
      logStructuralFailure('rows');
      throw new StructuralIntegrityError();
    }
    ids.add(membership.id);
    users.add(membership.userId);
  }
}

function findExactLockedActor(
  memberships: readonly LockedActiveMembership[],
  input: {
    homeId: string;
    actor: Pick<ActiveHomeActor, 'userId' | 'membershipId' | 'homeId'>;
  },
): LockedActiveMembership | undefined {
  return memberships.find(
    (membership) =>
      membership.id === input.actor.membershipId &&
      membership.userId === input.actor.userId &&
      membership.homeId === input.actor.homeId &&
      input.actor.homeId === input.homeId,
  );
}

/**
 * Lock the active Home then its complete active Membership set. This is the
 * public structural entry seam for invitation acceptance, where no Membership
 * actor exists yet.
 */
export async function lockActiveHomeStructureForEntry(
  tx: TransactionContext,
  input: { homeId: string },
): Promise<LockedHomeEntryStructure> {
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

  let membershipRows: MembershipLockRow[];
  try {
    const result = await tx.query<MembershipLockRow>(
      LOCK_ACTIVE_MEMBERSHIPS_FOR_UPDATE_SQL,
      [input.homeId],
    );
    membershipRows = result.rows;
  } catch {
    throw new TransactionInfrastructureError();
  }

  const activeMemberships = membershipRows.map((row) =>
    parseLockedMembership(row, input.homeId),
  );
  assertUniqueActiveSet(activeMemberships);

  const invariant = evaluateHomeStructureInvariant({
    archived: homeRow.archived_at !== null,
    activeMemberships,
  });
  if (!invariant.ok) {
    logStructuralFailure('invariant');
    throw new StructuralIntegrityError();
  }

  return Object.freeze({
    home: Object.freeze({
      id: homeRow.id,
      archived: homeRow.archived_at !== null,
    }),
    activeMemberships: Object.freeze(activeMemberships),
  });
}

/**
 * Lock Home then active Memberships, revalidate the exact actor tenure from
 * transaction-current rows, and refuse existing zero-admin corruption.
 * Input actor.role is ignored; the locked actor uses the DB role.
 */
export async function lockHomeStructure(
  tx: TransactionContext,
  input: {
    homeId: string;
    actor: Pick<ActiveHomeActor, 'userId' | 'membershipId' | 'homeId' | 'role'>;
  },
): Promise<LockedHomeStructure> {
  const locked = await lockActiveHomeStructureForEntry(tx, input);
  if (locked.home.archived) {
    throw new ConcealedNotFoundError();
  }
  const lockedMembership = findExactLockedActor(
    locked.activeMemberships,
    input,
  );
  if (lockedMembership === undefined) {
    throw new ConcealedNotFoundError();
  }

  return Object.freeze({
    ...locked,
    actor: Object.freeze({
      userId: lockedMembership.userId,
      membershipId: lockedMembership.id,
      homeId: lockedMembership.homeId,
      role: lockedMembership.role,
    }),
  });
}
