import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { TaskActivitySourceIntegrityError } from './errors.js';
import { isTaskStatus, type TaskStatus } from './task.js';

/**
 * Public Activity-safe canonical Task projection. No title, assignee, names,
 * or user identifiers. Caller supplies the expected Home.
 */
export type TaskActivitySource = Readonly<{
  id: string;
  homeId: string;
  status: TaskStatus;
  completedAt: Date | null;
  completedByMembershipId: string | null;
}>;

export type FindTaskActivitySourceInput = Readonly<{
  taskInstanceId: string;
  expectedHomeId: string;
}>;

export type FindTaskActivitySource = (
  tx: TransactionContext,
  input: FindTaskActivitySourceInput,
) => Promise<TaskActivitySource | null>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const FIND_TASK_ACTIVITY_SOURCE_SQL = `
SELECT
  t.id,
  t.home_id,
  t.status,
  t.completed_at,
  t.completed_by_membership_id
FROM task_instances t
WHERE t.id = $1::uuid
LIMIT 2
`;

type SourceRow = {
  id: unknown;
  home_id: unknown;
  status: unknown;
  completed_at: unknown;
  completed_by_membership_id: unknown;
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
  throw new TaskActivitySourceIntegrityError();
}

function optionalDate(value: unknown): Date | null {
  if (value === null) {
    return null;
  }
  if (isDate(value)) {
    return value;
  }
  throw new TaskActivitySourceIntegrityError();
}

function parseSourceRow(row: SourceRow): TaskActivitySource {
  if (!isUuid(row.id) || !isUuid(row.home_id) || !isTaskStatus(row.status)) {
    throw new TaskActivitySourceIntegrityError();
  }

  return Object.freeze({
    id: row.id,
    homeId: row.home_id,
    status: row.status,
    completedAt: optionalDate(row.completed_at),
    completedByMembershipId: optionalUuid(row.completed_by_membership_id),
  });
}

/**
 * Loads the Activity-safe canonical Task row inside the caller's transaction.
 * Missing source is null. Home mismatch is an integrity failure. Never selects
 * title, assignee, or user identifiers.
 */
export async function findTaskActivitySource(
  tx: TransactionContext,
  input: FindTaskActivitySourceInput,
): Promise<TaskActivitySource | null> {
  if (!isUuid(input.taskInstanceId) || !isUuid(input.expectedHomeId)) {
    throw new TaskActivitySourceIntegrityError();
  }

  let sourceRows: SourceRow[];
  try {
    const result = await tx.query<SourceRow>(FIND_TASK_ACTIVITY_SOURCE_SQL, [
      input.taskInstanceId,
    ]);
    sourceRows = result.rows;
  } catch (error) {
    if (error instanceof TaskActivitySourceIntegrityError) {
      throw error;
    }
    throw new TaskActivitySourceIntegrityError();
  }

  if (sourceRows.length === 0) {
    return null;
  }
  if (sourceRows.length !== 1 || sourceRows[0] === undefined) {
    throw new TaskActivitySourceIntegrityError();
  }

  const parsed = parseSourceRow(sourceRows[0]);
  if (parsed.homeId !== input.expectedHomeId) {
    throw new TaskActivitySourceIntegrityError();
  }

  return parsed;
}
