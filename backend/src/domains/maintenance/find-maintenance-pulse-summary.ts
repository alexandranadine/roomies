import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { MaintenancePulseSummaryIntegrityError } from './errors.js';

/**
 * Public Pulse Maintenance count. No titles, details, IDs, or audience rows
 * are returned to the caller.
 */
export type MaintenancePulseSummary = Readonly<{
  openVisibleCount: number;
}>;

export type FindMaintenancePulseSummaryInput = Readonly<{
  homeId: string;
  requesterMembershipId: string;
}>;

export type FindMaintenancePulseSummary = (
  tx: TransactionContext,
  input: FindMaintenancePulseSummaryInput,
) => Promise<MaintenancePulseSummary>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Counts OPEN Maintenance currently visible to the requester. Visibility is
 * embedded before COUNT. HOUSEHOLD is visible to an active same-Home
 * roommate. PRIVATE is visible only when the exact requester Membership is
 * in the immutable audience. No Admin or user-identity branch.
 */
export const FIND_MAINTENANCE_PULSE_SUMMARY_SQL = `
SELECT COUNT(*)::int AS open_visible_count
FROM maintenance_entries e
WHERE e.home_id = $1::uuid
  AND e.status = 'OPEN'
  AND (
    e.visibility = 'HOUSEHOLD'
    OR (
      e.visibility = 'PRIVATE'
      AND EXISTS (
        SELECT 1
        FROM maintenance_audiences a
        WHERE a.home_id = e.home_id
          AND a.maintenance_entry_id = e.id
          AND a.membership_id = $2::uuid
      )
    )
  )
`;

type SummaryRow = {
  open_visible_count: unknown;
};

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function asCount(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) {
    return Number(value);
  }
  throw new MaintenancePulseSummaryIntegrityError();
}

/**
 * Counts Pulse-visible OPEN Maintenance inside the caller's transaction.
 * Does not select title, details, or audience membership IDs.
 */
export async function findMaintenancePulseSummary(
  tx: TransactionContext,
  input: FindMaintenancePulseSummaryInput,
): Promise<MaintenancePulseSummary> {
  if (!isUuid(input.homeId) || !isUuid(input.requesterMembershipId)) {
    throw new MaintenancePulseSummaryIntegrityError();
  }

  let rows: SummaryRow[];
  try {
    const result = await tx.query<SummaryRow>(
      FIND_MAINTENANCE_PULSE_SUMMARY_SQL,
      [input.homeId, input.requesterMembershipId],
    );
    rows = result.rows;
  } catch (error) {
    if (error instanceof MaintenancePulseSummaryIntegrityError) {
      throw error;
    }
    throw new MaintenancePulseSummaryIntegrityError();
  }

  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    throw new MaintenancePulseSummaryIntegrityError();
  }

  return Object.freeze({
    openVisibleCount: asCount(row.open_visible_count),
  });
}
