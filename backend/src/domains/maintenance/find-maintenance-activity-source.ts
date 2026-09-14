import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { MaintenanceActivitySourceIntegrityError } from './errors.js';
import {
  isMaintenanceStatus,
  isMaintenanceVisibility,
  type MaintenanceStatus,
  type MaintenanceVisibility,
} from './maintenance.js';

/**
 * Public Activity-safe canonical Maintenance projection. No title, details,
 * names, or user identifiers. Caller supplies the expected Home.
 */
export type MaintenanceActivitySource = Readonly<{
  id: string;
  homeId: string;
  visibility: MaintenanceVisibility;
  status: MaintenanceStatus;
  createdByMembershipId: string;
  resolvedByMembershipId: string | null;
  resolvedAt: Date | null;
  audienceMembershipIds: readonly string[];
}>;

export type FindMaintenanceActivitySourceInput = Readonly<{
  maintenanceEntryId: string;
  expectedHomeId: string;
}>;

export type FindMaintenanceActivitySource = (
  tx: TransactionContext,
  input: FindMaintenanceActivitySourceInput,
) => Promise<MaintenanceActivitySource | null>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const FIND_MAINTENANCE_ACTIVITY_SOURCE_SQL = `
SELECT
  e.id,
  e.home_id,
  e.visibility,
  e.status,
  e.created_by_membership_id,
  e.resolved_by_membership_id,
  e.resolved_at
FROM maintenance_entries e
WHERE e.id = $1::uuid
LIMIT 2
`;

export const FIND_MAINTENANCE_ACTIVITY_SOURCE_AUDIENCE_SQL = `
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
  resolved_by_membership_id: unknown;
  resolved_at: unknown;
};

type AudienceRow = {
  membership_id: unknown;
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
  throw new MaintenanceActivitySourceIntegrityError();
}

function optionalDate(value: unknown): Date | null {
  if (value === null) {
    return null;
  }
  if (isDate(value)) {
    return value;
  }
  throw new MaintenanceActivitySourceIntegrityError();
}

function parseSourceRow(row: SourceRow): MaintenanceActivitySource {
  if (
    !isUuid(row.id) ||
    !isUuid(row.home_id) ||
    !isMaintenanceVisibility(row.visibility) ||
    !isMaintenanceStatus(row.status) ||
    !isUuid(row.created_by_membership_id)
  ) {
    throw new MaintenanceActivitySourceIntegrityError();
  }

  return Object.freeze({
    id: row.id,
    homeId: row.home_id,
    visibility: row.visibility,
    status: row.status,
    createdByMembershipId: row.created_by_membership_id,
    resolvedByMembershipId: optionalUuid(row.resolved_by_membership_id),
    resolvedAt: optionalDate(row.resolved_at),
    audienceMembershipIds: Object.freeze([]),
  });
}

/**
 * Loads the Activity-safe canonical Maintenance row inside the caller's
 * transaction. Missing source is null. Home mismatch and audience cardinality
 * violations are integrity failures. Never selects title or details.
 */
export async function findMaintenanceActivitySource(
  tx: TransactionContext,
  input: FindMaintenanceActivitySourceInput,
): Promise<MaintenanceActivitySource | null> {
  if (!isUuid(input.maintenanceEntryId) || !isUuid(input.expectedHomeId)) {
    throw new MaintenanceActivitySourceIntegrityError();
  }

  let sourceRows: SourceRow[];
  try {
    const result = await tx.query<SourceRow>(
      FIND_MAINTENANCE_ACTIVITY_SOURCE_SQL,
      [input.maintenanceEntryId],
    );
    sourceRows = result.rows;
  } catch (error) {
    if (error instanceof MaintenanceActivitySourceIntegrityError) {
      throw error;
    }
    throw new MaintenanceActivitySourceIntegrityError();
  }

  if (sourceRows.length === 0) {
    return null;
  }
  if (sourceRows.length !== 1 || sourceRows[0] === undefined) {
    throw new MaintenanceActivitySourceIntegrityError();
  }

  const parsed = parseSourceRow(sourceRows[0]);
  if (parsed.homeId !== input.expectedHomeId) {
    throw new MaintenanceActivitySourceIntegrityError();
  }

  let audienceRows: AudienceRow[];
  try {
    const result = await tx.query<AudienceRow>(
      FIND_MAINTENANCE_ACTIVITY_SOURCE_AUDIENCE_SQL,
      [parsed.id, parsed.homeId],
    );
    audienceRows = result.rows;
  } catch (error) {
    if (error instanceof MaintenanceActivitySourceIntegrityError) {
      throw error;
    }
    throw new MaintenanceActivitySourceIntegrityError();
  }

  const audience: string[] = [];
  const seen = new Set<string>();
  for (const row of audienceRows) {
    if (!isUuid(row.membership_id) || seen.has(row.membership_id)) {
      throw new MaintenanceActivitySourceIntegrityError();
    }
    seen.add(row.membership_id);
    audience.push(row.membership_id);
  }

  if (parsed.visibility === 'HOUSEHOLD' && audience.length !== 0) {
    throw new MaintenanceActivitySourceIntegrityError();
  }
  if (parsed.visibility === 'PRIVATE' && audience.length === 0) {
    throw new MaintenanceActivitySourceIntegrityError();
  }

  return Object.freeze({
    ...parsed,
    audienceMembershipIds: Object.freeze(audience),
  });
}
