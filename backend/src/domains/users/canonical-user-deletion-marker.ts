import { TransactionInfrastructureError } from '../../platform/persistence/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';

/**
 * Lock the canonical User row for a caller-owned lifecycle transaction.
 * Returns deletedAt so callers can observe the marker without inferring
 * deletion from row absence.
 */
export const LOCK_CANONICAL_USER_FOR_UPDATE_SQL = `
SELECT id, deleted_at
FROM users
WHERE id = $1
FOR UPDATE
`;

/**
 * Exact deleted_at-only writer. Caller supplies the transaction timestamp.
 * Does not delete the User row or related Membership/Auth rows.
 */
export const MARK_CANONICAL_USER_DELETED_SQL = `
UPDATE users
SET deleted_at = $1
WHERE id = $2
  AND deleted_at IS NULL
`;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LockedCanonicalUser = Readonly<{
  userId: string;
  deletedAt: Date | null;
}>;

export type CanonicalUserDeletionMarkerPersistence = {
  lockByUserId(
    tx: TransactionContext,
    userId: string,
  ): Promise<LockedCanonicalUser | null>;
  markDeleted(
    tx: TransactionContext,
    input: Readonly<{ userId: string; deletedAt: Date }>,
  ): Promise<number>;
};

/** Lock-only slice of the public marker port. Does not write deletedAt. */
export type CanonicalUserLockPort = Pick<
  CanonicalUserDeletionMarkerPersistence,
  'lockByUserId'
>;

type CanonicalUserLockRow = {
  id: unknown;
  deleted_at: unknown;
};

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isDateOrNull(value: unknown): value is Date | null {
  return (
    value === null || (value instanceof Date && !Number.isNaN(value.valueOf()))
  );
}

function logIntegrityFailure(): void {
  console.error('[users] canonical user persistence integrity failure', {
    errorClass: 'row',
  });
}

export class CanonicalUserPersistenceIntegrityError extends Error {
  override readonly name = 'CanonicalUserPersistenceIntegrityError';

  constructor() {
    super('Canonical user persistence integrity failure');
  }
}

function parseLockedCanonicalUser(
  row: CanonicalUserLockRow,
  userId: string,
): LockedCanonicalUser {
  if (!isUuid(row.id) || row.id !== userId || !isDateOrNull(row.deleted_at)) {
    logIntegrityFailure();
    throw new CanonicalUserPersistenceIntegrityError();
  }

  return Object.freeze({
    userId: row.id,
    deletedAt: row.deleted_at,
  });
}

/**
 * Narrow public persistence port for future account-lifecycle transactions.
 * Callers own BEGIN/COMMIT. Does not orchestrate deletion.
 */
export function createCanonicalUserDeletionMarkerPersistence(): CanonicalUserDeletionMarkerPersistence {
  return Object.freeze({
    async lockByUserId(tx, userId) {
      let rows: CanonicalUserLockRow[];
      try {
        const result = await tx.query<CanonicalUserLockRow>(
          LOCK_CANONICAL_USER_FOR_UPDATE_SQL,
          [userId],
        );
        rows = result.rows;
      } catch {
        throw new TransactionInfrastructureError();
      }

      if (rows.length > 1) {
        logIntegrityFailure();
        throw new CanonicalUserPersistenceIntegrityError();
      }

      const row = rows[0];
      if (row === undefined) {
        return null;
      }

      return parseLockedCanonicalUser(row, userId);
    },

    async markDeleted(tx, input) {
      try {
        const result = await tx.query(MARK_CANONICAL_USER_DELETED_SQL, [
          input.deletedAt,
          input.userId,
        ]);
        return result.rowCount ?? 0;
      } catch {
        throw new TransactionInfrastructureError();
      }
    },
  });
}
