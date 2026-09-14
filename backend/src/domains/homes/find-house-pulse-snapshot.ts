import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { canonicalizeIanaTimeZone } from '../../platform/time/iana-timezone.js';
import { HousePulseSnapshotIntegrityError } from './errors.js';

/**
 * Authoritative Pulse snapshot clock and Home timezone. Established by the
 * first statement inside the caller's REPEATABLE READ transaction.
 */
export type HousePulseSnapshot = Readonly<{
  generatedAt: Date;
  timezone: string;
}>;

export type FindHousePulseSnapshotInput = Readonly<{
  homeId: string;
  requesterMembershipId: string;
}>;

export type FindHousePulseSnapshot = (
  tx: TransactionContext,
  input: FindHousePulseSnapshotInput,
) => Promise<HousePulseSnapshot | null>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const SELECT_HOUSE_PULSE_GENERATED_AT_SQL = `
SELECT transaction_timestamp() AS generated_at
`;

export const FIND_HOUSE_PULSE_TIMEZONE_SQL = `
SELECT h.timezone
FROM homes h
INNER JOIN memberships m
  ON m.home_id = h.id
 AND m.id = $2::uuid
 AND m.ended_at IS NULL
WHERE h.id = $1::uuid
  AND h.archived_at IS NULL
LIMIT 2
`;

type GeneratedAtRow = {
  generated_at: unknown;
};

type TimezoneRow = {
  timezone: unknown;
};

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.valueOf());
}

/**
 * First statement obtains transaction_timestamp() and establishes the
 * snapshot. Second statement loads the active Home timezone for the exact
 * requester Membership. Archived Home or ended Membership is null.
 */
export async function findHousePulseSnapshot(
  tx: TransactionContext,
  input: FindHousePulseSnapshotInput,
): Promise<HousePulseSnapshot | null> {
  if (!isUuid(input.homeId) || !isUuid(input.requesterMembershipId)) {
    throw new HousePulseSnapshotIntegrityError();
  }

  let generatedRows: GeneratedAtRow[];
  try {
    const result = await tx.query<GeneratedAtRow>(
      SELECT_HOUSE_PULSE_GENERATED_AT_SQL,
    );
    generatedRows = result.rows;
  } catch (error) {
    if (error instanceof HousePulseSnapshotIntegrityError) {
      throw error;
    }
    throw new HousePulseSnapshotIntegrityError();
  }

  const generatedRow = generatedRows[0];
  if (
    generatedRows.length !== 1 ||
    generatedRow === undefined ||
    !isDate(generatedRow.generated_at)
  ) {
    throw new HousePulseSnapshotIntegrityError();
  }

  let timezoneRows: TimezoneRow[];
  try {
    const result = await tx.query<TimezoneRow>(FIND_HOUSE_PULSE_TIMEZONE_SQL, [
      input.homeId,
      input.requesterMembershipId,
    ]);
    timezoneRows = result.rows;
  } catch (error) {
    if (error instanceof HousePulseSnapshotIntegrityError) {
      throw error;
    }
    throw new HousePulseSnapshotIntegrityError();
  }

  if (timezoneRows.length === 0) {
    return null;
  }
  const timezoneRow = timezoneRows[0];
  if (
    timezoneRows.length !== 1 ||
    timezoneRow === undefined ||
    typeof timezoneRow.timezone !== 'string'
  ) {
    throw new HousePulseSnapshotIntegrityError();
  }

  try {
    return Object.freeze({
      generatedAt: generatedRow.generated_at,
      timezone: canonicalizeIanaTimeZone(timezoneRow.timezone),
    });
  } catch {
    throw new HousePulseSnapshotIntegrityError();
  }
}
