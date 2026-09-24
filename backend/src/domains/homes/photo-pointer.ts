import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  AuthorizationIntegrityError,
  ConcealedNotFoundError,
  isMembershipRole,
} from '../../platform/authz/index.js';
import { TransactionInfrastructureError } from '../../platform/persistence/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import type { Home } from './home.js';
import {
  isCanonicalHomePhotoObjectKey,
  storedHomePhotoObjectKey,
} from './photo-object-key.js';
import { isTempHomePhotoObjectKey } from './temp-photo-object-key.js';

/**
 * Home-photo mutation mutex. Filters archived Homes in SQL so a missing and
 * archived Home share concealed 404. Captures the current canonical pointer.
 */
export const LOCK_ACTIVE_HOME_PHOTO_FOR_UPDATE_SQL = `
SELECT id, name, timezone, photo_object_key
FROM homes
WHERE id = $1
  AND archived_at IS NULL
FOR UPDATE
`;

/**
 * Re-check the exact request Membership under the Home row lock.
 * Home photo is cosmetic: this does not load the full active set or evaluate
 * the Admin structural invariant.
 */
export const SELECT_EXACT_MEMBERSHIP_FOR_PHOTO_SQL = `
SELECT id, user_id, home_id, role, ended_at
FROM memberships
WHERE id = $1
`;

export const REPLACE_HOME_PHOTO_POINTER_SQL = `
UPDATE homes
SET photo_object_key = $1,
    updated_at = now()
WHERE id = $2
  AND archived_at IS NULL
`;

export const CLEAR_HOME_PHOTO_POINTER_SQL = `
UPDATE homes
SET photo_object_key = NULL,
    updated_at = now()
WHERE id = $1
  AND archived_at IS NULL
`;

export type LockedHomePhotoMutation = Readonly<{
  home: Home;
  actor: ActiveHomeActor;
}>;

export type HomePhotoPointerWriter = {
  lockActiveHomeForPhotoMutation(
    tx: TransactionContext,
    input: {
      homeId: string;
      actor: Pick<
        ActiveHomeActor,
        'userId' | 'membershipId' | 'homeId' | 'role'
      >;
    },
  ): Promise<LockedHomePhotoMutation>;
  replacePhotoPointer(
    tx: TransactionContext,
    input: Readonly<{ homeId: string; photoObjectKey: string }>,
  ): Promise<void>;
  clearPhotoPointer(
    tx: TransactionContext,
    input: Readonly<{ homeId: string }>,
  ): Promise<void>;
};

type HomeLockRow = {
  id: unknown;
  name: unknown;
  timezone: unknown;
  photo_object_key: unknown;
};

type MembershipRecheckRow = {
  id: unknown;
  user_id: unknown;
  home_id: unknown;
  role: unknown;
  ended_at: unknown;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isDateOrNull(value: unknown): value is Date | null {
  return (
    value === null || (value instanceof Date && !Number.isNaN(value.valueOf()))
  );
}

function mapLockedHome(row: HomeLockRow, homeId: string): Home {
  if (
    !isUuid(row.id) ||
    row.id !== homeId ||
    typeof row.name !== 'string' ||
    typeof row.timezone !== 'string'
  ) {
    throw new AuthorizationIntegrityError();
  }

  return Object.freeze({
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    photoObjectKey: storedHomePhotoObjectKey(row.photo_object_key, row.id),
  });
}

function assertWritableCanonicalPointer(homeId: string, key: string): void {
  if (isTempHomePhotoObjectKey(key, homeId) || key.startsWith('tmp/')) {
    throw new AuthorizationIntegrityError();
  }
  if (!isCanonicalHomePhotoObjectKey(key, homeId)) {
    throw new AuthorizationIntegrityError();
  }
}

/**
 * Lock the active Home row, capture the photo pointer, and re-check the exact
 * request Membership is still current for this Home and actor.
 */
export async function lockActiveHomeForPhotoMutation(
  tx: TransactionContext,
  input: {
    homeId: string;
    actor: Pick<ActiveHomeActor, 'userId' | 'membershipId' | 'homeId' | 'role'>;
  },
): Promise<LockedHomePhotoMutation> {
  let homeRows: HomeLockRow[];
  try {
    const result = await tx.query<HomeLockRow>(
      LOCK_ACTIVE_HOME_PHOTO_FOR_UPDATE_SQL,
      [input.homeId],
    );
    homeRows = result.rows;
  } catch {
    throw new TransactionInfrastructureError();
  }

  const homeRow = homeRows[0];
  if (homeRows.length > 1) {
    throw new AuthorizationIntegrityError();
  }
  if (homeRows.length === 0 || homeRow === undefined) {
    throw new ConcealedNotFoundError();
  }

  const home = mapLockedHome(homeRow, input.homeId);

  let membershipRows: MembershipRecheckRow[];
  try {
    const result = await tx.query<MembershipRecheckRow>(
      SELECT_EXACT_MEMBERSHIP_FOR_PHOTO_SQL,
      [input.actor.membershipId],
    );
    membershipRows = result.rows;
  } catch {
    throw new TransactionInfrastructureError();
  }

  const membershipRow = membershipRows[0];
  if (membershipRows.length > 1) {
    throw new AuthorizationIntegrityError();
  }
  if (membershipRow === undefined) {
    throw new ConcealedNotFoundError();
  }

  if (
    !isUuid(membershipRow.id) ||
    !isUuid(membershipRow.user_id) ||
    !isUuid(membershipRow.home_id) ||
    !isMembershipRole(membershipRow.role) ||
    !isDateOrNull(membershipRow.ended_at)
  ) {
    throw new AuthorizationIntegrityError();
  }

  if (
    membershipRow.id !== input.actor.membershipId ||
    membershipRow.user_id !== input.actor.userId ||
    membershipRow.home_id !== input.homeId ||
    membershipRow.home_id !== input.actor.homeId ||
    membershipRow.home_id !== home.id ||
    membershipRow.ended_at !== null
  ) {
    throw new ConcealedNotFoundError();
  }

  return Object.freeze({
    home,
    actor: Object.freeze({
      userId: membershipRow.user_id,
      membershipId: membershipRow.id,
      homeId: membershipRow.home_id,
      role: membershipRow.role,
    }),
  });
}

export async function replaceHomePhotoPointer(
  tx: TransactionContext,
  input: Readonly<{ homeId: string; photoObjectKey: string }>,
): Promise<void> {
  assertWritableCanonicalPointer(input.homeId, input.photoObjectKey);
  try {
    const result = await tx.query(REPLACE_HOME_PHOTO_POINTER_SQL, [
      input.photoObjectKey,
      input.homeId,
    ]);
    if (result.rowCount !== 1) {
      throw new TransactionInfrastructureError();
    }
  } catch (error) {
    if (
      error instanceof TransactionInfrastructureError ||
      error instanceof AuthorizationIntegrityError
    ) {
      throw error;
    }
    throw new TransactionInfrastructureError();
  }
}

export async function clearHomePhotoPointer(
  tx: TransactionContext,
  input: Readonly<{ homeId: string }>,
): Promise<void> {
  try {
    const result = await tx.query(CLEAR_HOME_PHOTO_POINTER_SQL, [input.homeId]);
    if (result.rowCount !== 1) {
      throw new TransactionInfrastructureError();
    }
  } catch (error) {
    if (error instanceof TransactionInfrastructureError) {
      throw error;
    }
    throw new TransactionInfrastructureError();
  }
}

export function createHomePhotoPointerWriter(): HomePhotoPointerWriter {
  return Object.freeze({
    lockActiveHomeForPhotoMutation,
    replacePhotoPointer: replaceHomePhotoPointer,
    clearPhotoPointer: clearHomePhotoPointer,
  });
}
