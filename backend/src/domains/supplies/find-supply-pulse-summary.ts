import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { SupplyPulseSummaryIntegrityError } from './errors.js';

/**
 * Public Pulse Supply counts. No Supply rows, titles, or claim identities
 * are returned to the caller.
 */
export type SupplyPulseSummary = Readonly<{
  openCount: number;
  unclaimedOpenCount: number;
  claimedByMeCount: number;
}>;

export type FindSupplyPulseSummaryInput = Readonly<{
  homeId: string;
  requesterMembershipId: string;
}>;

export type FindSupplyPulseSummary = (
  tx: TransactionContext,
  input: FindSupplyPulseSummaryInput,
) => Promise<SupplyPulseSummary>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Aggregates OPEN SupplyEntries and the single active claim (released_at IS
 * NULL). Historical released claims do not join and cannot count as claimed.
 */
export const FIND_SUPPLY_PULSE_SUMMARY_SQL = `
SELECT
  COUNT(*)::int AS open_count,
  COUNT(*) FILTER (
    WHERE c.supply_entry_id IS NULL
  )::int AS unclaimed_open_count,
  COUNT(*) FILTER (
    WHERE c.claimant_membership_id = $2::uuid
  )::int AS claimed_by_me_count
FROM supply_entries e
LEFT JOIN supply_claims c
  ON c.home_id = e.home_id
 AND c.supply_entry_id = e.id
 AND c.released_at IS NULL
WHERE e.home_id = $1::uuid
  AND e.status = 'OPEN'
`;

type SummaryRow = {
  open_count: unknown;
  unclaimed_open_count: unknown;
  claimed_by_me_count: unknown;
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
  throw new SupplyPulseSummaryIntegrityError();
}

/**
 * Counts Pulse-relevant OPEN Supplies inside the caller's transaction.
 * Does not return Supply rows.
 */
export async function findSupplyPulseSummary(
  tx: TransactionContext,
  input: FindSupplyPulseSummaryInput,
): Promise<SupplyPulseSummary> {
  if (!isUuid(input.homeId) || !isUuid(input.requesterMembershipId)) {
    throw new SupplyPulseSummaryIntegrityError();
  }

  let rows: SummaryRow[];
  try {
    const result = await tx.query<SummaryRow>(FIND_SUPPLY_PULSE_SUMMARY_SQL, [
      input.homeId,
      input.requesterMembershipId,
    ]);
    rows = result.rows;
  } catch (error) {
    if (error instanceof SupplyPulseSummaryIntegrityError) {
      throw error;
    }
    throw new SupplyPulseSummaryIntegrityError();
  }

  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    throw new SupplyPulseSummaryIntegrityError();
  }

  return Object.freeze({
    openCount: asCount(row.open_count),
    unclaimedOpenCount: asCount(row.unclaimed_open_count),
    claimedByMeCount: asCount(row.claimed_by_me_count),
  });
}
