import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { TaskNotificationSourceIntegrityError } from './errors.js';
import { isTaskStatus, type TaskStatus } from './task.js';

/**
 * Public Notification-safe canonical Task completion evidence. Assignment is
 * the exact persisted instance assignment, never a current definition value.
 */
export type TaskNotificationSource = Readonly<{
  id: string;
  homeId: string;
  status: TaskStatus;
  assignedMembershipId: string | null;
  completedAt: Date | null;
  completedByMembershipId: string | null;
}>;

export type FindTaskNotificationSource = (
  tx: TransactionContext,
  input: Readonly<{ taskInstanceId: string; expectedHomeId: string }>,
) => Promise<TaskNotificationSource | null>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const FIND_TASK_NOTIFICATION_SOURCE_SQL = `
SELECT
  t.id,
  t.home_id,
  t.status,
  t.assigned_membership_id,
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
  assigned_membership_id: unknown;
  completed_at: unknown;
  completed_by_membership_id: unknown;
};

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function optionalUuid(value: unknown): string | null {
  if (value === null || isUuid(value)) {
    return value;
  }
  throw new TaskNotificationSourceIntegrityError();
}

function optionalDate(value: unknown): Date | null {
  if (
    value === null ||
    (value instanceof Date && !Number.isNaN(value.valueOf()))
  ) {
    return value;
  }
  throw new TaskNotificationSourceIntegrityError();
}

export async function findTaskNotificationSource(
  tx: TransactionContext,
  input: Readonly<{ taskInstanceId: string; expectedHomeId: string }>,
): Promise<TaskNotificationSource | null> {
  if (!isUuid(input.taskInstanceId) || !isUuid(input.expectedHomeId)) {
    throw new TaskNotificationSourceIntegrityError();
  }

  let rows: SourceRow[];
  try {
    rows = (
      await tx.query<SourceRow>(FIND_TASK_NOTIFICATION_SOURCE_SQL, [
        input.taskInstanceId,
      ])
    ).rows;
  } catch {
    throw new TaskNotificationSourceIntegrityError();
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
    !isTaskStatus(row.status)
  ) {
    throw new TaskNotificationSourceIntegrityError();
  }

  const source = Object.freeze({
    id: row.id,
    homeId: row.home_id,
    status: row.status,
    assignedMembershipId: optionalUuid(row.assigned_membership_id),
    completedAt: optionalDate(row.completed_at),
    completedByMembershipId: optionalUuid(row.completed_by_membership_id),
  });
  if (
    source.id !== input.taskInstanceId ||
    source.homeId !== input.expectedHomeId
  ) {
    throw new TaskNotificationSourceIntegrityError();
  }
  return source;
}
