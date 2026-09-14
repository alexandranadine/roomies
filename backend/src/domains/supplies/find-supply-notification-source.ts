import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { SupplyNotificationSourceIntegrityError } from './errors.js';
import { isSupplyEntryStatus, type SupplyEntryStatus } from './supply.js';

/**
 * Public Notification-safe canonical Supply obtain evidence. It intentionally
 * excludes display data and claim history.
 */
export type SupplyNotificationSource = Readonly<{
  id: string;
  homeId: string;
  status: SupplyEntryStatus;
  createdByMembershipId: string;
  obtainedAt: Date | null;
  obtainedByMembershipId: string | null;
}>;

export type FindSupplyNotificationSource = (
  tx: TransactionContext,
  input: Readonly<{ supplyEntryId: string; expectedHomeId: string }>,
) => Promise<SupplyNotificationSource | null>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const FIND_SUPPLY_NOTIFICATION_SOURCE_SQL = `
SELECT
  e.id,
  e.home_id,
  e.status,
  e.created_by_membership_id,
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
  created_by_membership_id: unknown;
  obtained_at: unknown;
  obtained_by_membership_id: unknown;
};

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function optionalUuid(value: unknown): string | null {
  if (value === null || isUuid(value)) {
    return value;
  }
  throw new SupplyNotificationSourceIntegrityError();
}

function optionalDate(value: unknown): Date | null {
  if (
    value === null ||
    (value instanceof Date && !Number.isNaN(value.valueOf()))
  ) {
    return value;
  }
  throw new SupplyNotificationSourceIntegrityError();
}

export async function findSupplyNotificationSource(
  tx: TransactionContext,
  input: Readonly<{ supplyEntryId: string; expectedHomeId: string }>,
): Promise<SupplyNotificationSource | null> {
  if (!isUuid(input.supplyEntryId) || !isUuid(input.expectedHomeId)) {
    throw new SupplyNotificationSourceIntegrityError();
  }

  let rows: SourceRow[];
  try {
    rows = (
      await tx.query<SourceRow>(FIND_SUPPLY_NOTIFICATION_SOURCE_SQL, [
        input.supplyEntryId,
      ])
    ).rows;
  } catch {
    throw new SupplyNotificationSourceIntegrityError();
  }
  if (rows.length === 0) {
    return null;
  }
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row === undefined ||
    !isUuid(row.id) ||
    !isUuid(row.home_id) ||
    !isSupplyEntryStatus(row.status) ||
    !isUuid(row.created_by_membership_id)
  ) {
    throw new SupplyNotificationSourceIntegrityError();
  }

  const source = Object.freeze({
    id: row.id,
    homeId: row.home_id,
    status: row.status,
    createdByMembershipId: row.created_by_membership_id,
    obtainedAt: optionalDate(row.obtained_at),
    obtainedByMembershipId: optionalUuid(row.obtained_by_membership_id),
  });
  if (
    source.id !== input.supplyEntryId ||
    source.homeId !== input.expectedHomeId
  ) {
    throw new SupplyNotificationSourceIntegrityError();
  }
  return source;
}
