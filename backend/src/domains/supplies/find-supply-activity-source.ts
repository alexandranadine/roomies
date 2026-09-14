import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { SupplyActivitySourceIntegrityError } from './errors.js';
import { isSupplyEntryStatus, type SupplyEntryStatus } from './supply.js';

/**
 * Public Activity-safe canonical Supply projection. No display fields or
 * user identifiers. Caller supplies the expected Home.
 */
export type SupplyActivitySource = Readonly<{
  id: string;
  homeId: string;
  status: SupplyEntryStatus;
  obtainedAt: Date | null;
  obtainedByMembershipId: string | null;
}>;

export type FindSupplyActivitySourceInput = Readonly<{
  supplyEntryId: string;
  expectedHomeId: string;
}>;

export type FindSupplyActivitySource = (
  tx: TransactionContext,
  input: FindSupplyActivitySourceInput,
) => Promise<SupplyActivitySource | null>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const FIND_SUPPLY_ACTIVITY_SOURCE_SQL = `
SELECT
  e.id,
  e.home_id,
  e.status,
  e.obtained_at,
  e.obtained_by_membership_id
FROM supply_entries e
WHERE e.id = $1::uuid
LIMIT 2
`;

type SourceRow = {
  id: unknown;
  home_id: unknown;
  status: unknown;
  obtained_at: unknown;
  obtained_by_membership_id: unknown;
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
  throw new SupplyActivitySourceIntegrityError();
}

function optionalDate(value: unknown): Date | null {
  if (value === null) {
    return null;
  }
  if (isDate(value)) {
    return value;
  }
  throw new SupplyActivitySourceIntegrityError();
}

function parseSourceRow(row: SourceRow): SupplyActivitySource {
  if (
    !isUuid(row.id) ||
    !isUuid(row.home_id) ||
    !isSupplyEntryStatus(row.status)
  ) {
    throw new SupplyActivitySourceIntegrityError();
  }

  return Object.freeze({
    id: row.id,
    homeId: row.home_id,
    status: row.status,
    obtainedAt: optionalDate(row.obtained_at),
    obtainedByMembershipId: optionalUuid(row.obtained_by_membership_id),
  });
}

/**
 * Loads the Activity-safe canonical Supply row inside the caller's
 * transaction. Missing source is null. Home mismatch is an integrity failure.
 * Never selects display fields or user identifiers.
 */
export async function findSupplyActivitySource(
  tx: TransactionContext,
  input: FindSupplyActivitySourceInput,
): Promise<SupplyActivitySource | null> {
  if (!isUuid(input.supplyEntryId) || !isUuid(input.expectedHomeId)) {
    throw new SupplyActivitySourceIntegrityError();
  }

  let sourceRows: SourceRow[];
  try {
    const result = await tx.query<SourceRow>(FIND_SUPPLY_ACTIVITY_SOURCE_SQL, [
      input.supplyEntryId,
    ]);
    sourceRows = result.rows;
  } catch (error) {
    if (error instanceof SupplyActivitySourceIntegrityError) {
      throw error;
    }
    throw new SupplyActivitySourceIntegrityError();
  }

  if (sourceRows.length === 0) {
    return null;
  }
  if (sourceRows.length !== 1 || sourceRows[0] === undefined) {
    throw new SupplyActivitySourceIntegrityError();
  }

  const parsed = parseSourceRow(sourceRows[0]);
  if (parsed.homeId !== input.expectedHomeId) {
    throw new SupplyActivitySourceIntegrityError();
  }

  return parsed;
}
