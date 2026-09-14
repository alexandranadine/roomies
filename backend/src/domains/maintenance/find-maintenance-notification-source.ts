import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { MaintenanceNotificationSourceIntegrityError } from './errors.js';
import {
  isMaintenanceStatus,
  isMaintenanceVisibility,
  isValidMaintenanceLifecycle,
  type MaintenanceStatus,
  type MaintenanceVisibility,
} from './maintenance.js';

/**
 * Public Notification-safe canonical Maintenance evidence. Protected entry
 * content and user identity are never selected.
 */
export type MaintenanceNotificationSource = Readonly<{
  id: string;
  homeId: string;
  visibility: MaintenanceVisibility;
  status: MaintenanceStatus;
  createdByMembershipId: string;
  createdAt: Date;
  resolvedByMembershipId: string | null;
  resolvedAt: Date | null;
  recipientMembershipIds: readonly string[];
}>;

export type FindMaintenanceNotificationSource = (
  tx: TransactionContext,
  input: Readonly<{ maintenanceEntryId: string; expectedHomeId: string }>,
) => Promise<MaintenanceNotificationSource | null>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const FIND_MAINTENANCE_NOTIFICATION_SOURCE_SQL = `
SELECT
  e.id,
  e.home_id,
  e.visibility,
  e.status,
  e.created_by_membership_id,
  e.created_at,
  e.resolved_by_membership_id,
  e.resolved_at,
  e.updated_at
FROM maintenance_entries e
WHERE e.id = $1::uuid
LIMIT 2
`;

export const FIND_MAINTENANCE_NOTIFICATION_RECIPIENTS_SQL = `
SELECT a.membership_id
FROM maintenance_audiences a
WHERE a.maintenance_entry_id = $1::uuid
  AND a.home_id = $2::uuid
ORDER BY a.membership_id ASC
`;

type SourceRow = {
  id: unknown;
  home_id: unknown;
  visibility: unknown;
  status: unknown;
  created_by_membership_id: unknown;
  created_at: unknown;
  resolved_by_membership_id: unknown;
  resolved_at: unknown;
  updated_at: unknown;
};

type RecipientRow = { membership_id: unknown };

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.valueOf());
}

function optionalUuid(value: unknown): string | null {
  if (value === null || isUuid(value)) {
    return value;
  }
  throw new MaintenanceNotificationSourceIntegrityError();
}

function optionalDate(value: unknown): Date | null {
  if (value === null || isDate(value)) {
    return value;
  }
  throw new MaintenanceNotificationSourceIntegrityError();
}

export async function findMaintenanceNotificationSource(
  tx: TransactionContext,
  input: Readonly<{ maintenanceEntryId: string; expectedHomeId: string }>,
): Promise<MaintenanceNotificationSource | null> {
  if (!isUuid(input.maintenanceEntryId) || !isUuid(input.expectedHomeId)) {
    throw new MaintenanceNotificationSourceIntegrityError();
  }

  let rows: SourceRow[];
  try {
    rows = (
      await tx.query<SourceRow>(FIND_MAINTENANCE_NOTIFICATION_SOURCE_SQL, [
        input.maintenanceEntryId,
      ])
    ).rows;
  } catch {
    throw new MaintenanceNotificationSourceIntegrityError();
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
    !isMaintenanceVisibility(row.visibility) ||
    !isMaintenanceStatus(row.status) ||
    !isUuid(row.created_by_membership_id) ||
    !isDate(row.created_at) ||
    !isDate(row.updated_at)
  ) {
    throw new MaintenanceNotificationSourceIntegrityError();
  }

  const resolvedByMembershipId = optionalUuid(row.resolved_by_membership_id);
  const resolvedAt = optionalDate(row.resolved_at);
  if (
    row.id !== input.maintenanceEntryId ||
    row.home_id !== input.expectedHomeId ||
    !isValidMaintenanceLifecycle({
      status: row.status,
      resolvedByMembershipId,
      resolvedAt,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })
  ) {
    throw new MaintenanceNotificationSourceIntegrityError();
  }

  let recipientRows: RecipientRow[];
  try {
    recipientRows = (
      await tx.query<RecipientRow>(
        FIND_MAINTENANCE_NOTIFICATION_RECIPIENTS_SQL,
        [row.id, row.home_id],
      )
    ).rows;
  } catch {
    throw new MaintenanceNotificationSourceIntegrityError();
  }

  const recipientMembershipIds: string[] = [];
  const seen = new Set<string>();
  for (const recipientRow of recipientRows) {
    if (
      !isUuid(recipientRow.membership_id) ||
      seen.has(recipientRow.membership_id)
    ) {
      throw new MaintenanceNotificationSourceIntegrityError();
    }
    seen.add(recipientRow.membership_id);
    recipientMembershipIds.push(recipientRow.membership_id);
  }
  if (
    (row.visibility === 'HOUSEHOLD' && recipientMembershipIds.length !== 0) ||
    (row.visibility === 'PRIVATE' && recipientMembershipIds.length === 0)
  ) {
    throw new MaintenanceNotificationSourceIntegrityError();
  }

  return Object.freeze({
    id: row.id,
    homeId: row.home_id,
    visibility: row.visibility,
    status: row.status,
    createdByMembershipId: row.created_by_membership_id,
    createdAt: row.created_at,
    resolvedByMembershipId,
    resolvedAt,
    recipientMembershipIds: Object.freeze(recipientMembershipIds),
  });
}
