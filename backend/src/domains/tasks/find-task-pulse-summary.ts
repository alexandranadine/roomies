import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { TaskPulseSummaryIntegrityError } from './errors.js';
import { HOME_LOCAL_DATE_PATTERN, type DateString } from './home-local-date.js';

/**
 * Public Pulse Task counts. No Task rows, titles, assignees, or user
 * identifiers are returned to the caller.
 */
export type TaskPulseSummary = Readonly<{
  assignedOpenCount: number;
  unassignedOpenCount: number;
  dueTodayRelevantCount: number;
  overdueRelevantCount: number;
}>;

export type FindTaskPulseSummaryInput = Readonly<{
  homeId: string;
  requesterMembershipId: string;
  homeLocalDate: DateString;
}>;

export type FindTaskPulseSummary = (
  tx: TransactionContext,
  input: FindTaskPulseSummaryInput,
) => Promise<TaskPulseSummary>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Aggregates OPEN TaskInstances that are assigned to the requester's exact
 * Membership or unassigned. Other-roommate assignments are excluded in SQL.
 * Due/overdue use the Home-local DATE column, not UTC midnight.
 */
export const FIND_TASK_PULSE_SUMMARY_SQL = `
SELECT
  COUNT(*) FILTER (
    WHERE assigned_membership_id = $2::uuid
  )::int AS assigned_open_count,
  COUNT(*) FILTER (
    WHERE assigned_membership_id IS NULL
  )::int AS unassigned_open_count,
  COUNT(*) FILTER (
    WHERE scheduled_for = $3::date
  )::int AS due_today_relevant_count,
  COUNT(*) FILTER (
    WHERE scheduled_for < $3::date
  )::int AS overdue_relevant_count
FROM task_instances
WHERE home_id = $1::uuid
  AND status = 'OPEN'
  AND (
    assigned_membership_id = $2::uuid
    OR assigned_membership_id IS NULL
  )
`;

type SummaryRow = {
  assigned_open_count: unknown;
  unassigned_open_count: unknown;
  due_today_relevant_count: unknown;
  overdue_relevant_count: unknown;
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
  throw new TaskPulseSummaryIntegrityError();
}

/**
 * Counts Pulse-relevant OPEN Tasks inside the caller's transaction.
 * Does not return Task rows and does not inspect TaskDefinitions.
 */
export async function findTaskPulseSummary(
  tx: TransactionContext,
  input: FindTaskPulseSummaryInput,
): Promise<TaskPulseSummary> {
  if (
    !isUuid(input.homeId) ||
    !isUuid(input.requesterMembershipId) ||
    !HOME_LOCAL_DATE_PATTERN.test(input.homeLocalDate)
  ) {
    throw new TaskPulseSummaryIntegrityError();
  }

  let rows: SummaryRow[];
  try {
    const result = await tx.query<SummaryRow>(FIND_TASK_PULSE_SUMMARY_SQL, [
      input.homeId,
      input.requesterMembershipId,
      input.homeLocalDate,
    ]);
    rows = result.rows;
  } catch (error) {
    if (error instanceof TaskPulseSummaryIntegrityError) {
      throw error;
    }
    throw new TaskPulseSummaryIntegrityError();
  }

  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    throw new TaskPulseSummaryIntegrityError();
  }

  return Object.freeze({
    assignedOpenCount: asCount(row.assigned_open_count),
    unassignedOpenCount: asCount(row.unassigned_open_count),
    dueTodayRelevantCount: asCount(row.due_today_relevant_count),
    overdueRelevantCount: asCount(row.overdue_relevant_count),
  });
}
