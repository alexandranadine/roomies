import type { Pool } from 'pg';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { TaskPersistenceError } from './errors.js';
import { HOME_LOCAL_DATE_PATTERN } from './home-local-date.js';
import { isTaskSource, isTaskStatus, type TaskInstance } from './task.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TASK_INSTANCE_COLUMNS = `
id,
home_id,
source,
status,
title,
scheduled_for::text AS scheduled_for,
assigned_membership_id,
completed_at,
created_at,
updated_at
`;

export const INSERT_MANUAL_TASK_INSTANCE_SQL = `
INSERT INTO task_instances (
  id,
  home_id,
  source,
  status,
  title,
  scheduled_for,
  assigned_membership_id,
  task_definition_id,
  completed_at,
  created_at,
  updated_at
)
VALUES (
  $1::uuid,
  $2::uuid,
  'MANUAL',
  'OPEN',
  $3,
  $4::date,
  $5::uuid,
  NULL,
  NULL,
  $6::timestamptz,
  $6::timestamptz
)
RETURNING ${TASK_INSTANCE_COLUMNS}
`;

export const FIND_TASK_INSTANCE_BY_HOME_AND_ID_SQL = `
SELECT ${TASK_INSTANCE_COLUMNS}
FROM task_instances
WHERE home_id = $1::uuid
  AND id = $2::uuid
LIMIT 2
`;

export const LIST_TASK_INSTANCES_BY_HOME_SQL = `
SELECT ${TASK_INSTANCE_COLUMNS}
FROM task_instances
WHERE home_id = $1::uuid
ORDER BY
  CASE WHEN status = 'OPEN' THEN 0 ELSE 1 END,
  CASE WHEN status = 'OPEN' THEN scheduled_for END ASC NULLS LAST,
  CASE WHEN status = 'OPEN' THEN created_at END ASC,
  CASE WHEN status = 'COMPLETED' THEN completed_at END ASC,
  id ASC
`;

export const LOCK_TASK_INSTANCE_BY_HOME_AND_ID_SQL = `
SELECT ${TASK_INSTANCE_COLUMNS}
FROM task_instances
WHERE home_id = $1::uuid
  AND id = $2::uuid
LIMIT 2
FOR UPDATE
`;

export const COMPLETE_OPEN_TASK_INSTANCE_SQL = `
UPDATE task_instances
SET
  status = 'COMPLETED',
  completed_at = $3::timestamptz,
  updated_at = $4::timestamptz
WHERE home_id = $1::uuid
  AND id = $2::uuid
  AND status = 'OPEN'
  AND completed_at IS NULL
RETURNING ${TASK_INSTANCE_COLUMNS}
`;

export type NewManualTaskInstance = Readonly<{
  id: string;
  homeId: string;
  title: string;
  scheduledFor: string | null;
  assignedMembershipId: string | null;
  createdAt: Date;
}>;

export type CompleteOpenTaskInstance = Readonly<{
  homeId: string;
  taskId: string;
  completedAt: Date;
  updatedAt: Date;
}>;

export type TaskRepository = Readonly<{
  insertManual(
    tx: TransactionContext,
    task: NewManualTaskInstance,
  ): Promise<TaskInstance>;
  findByHomeAndId(homeId: string, taskId: string): Promise<TaskInstance | null>;
  listByHome(homeId: string): Promise<readonly TaskInstance[]>;
  lockByHomeAndId(
    tx: TransactionContext,
    homeId: string,
    taskId: string,
  ): Promise<TaskInstance | null>;
  completeOpenTask(
    tx: TransactionContext,
    input: CompleteOpenTaskInstance,
  ): Promise<TaskInstance | null>;
}>;

type TaskInstanceRow = {
  id: unknown;
  home_id: unknown;
  source: unknown;
  status: unknown;
  title: unknown;
  scheduled_for: unknown;
  assigned_membership_id: unknown;
  completed_at: unknown;
  created_at: unknown;
  updated_at: unknown;
};

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.valueOf());
}

function parseScheduledFor(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value === 'string' && HOME_LOCAL_DATE_PATTERN.test(value)) {
    return value;
  }
  throw new TaskPersistenceError();
}

function parseOptionalUuid(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (isUuid(value)) {
    return value;
  }
  throw new TaskPersistenceError();
}

function parseCompletedAt(value: unknown): Date | null {
  if (value === null) {
    return null;
  }
  if (isDate(value)) {
    return value;
  }
  throw new TaskPersistenceError();
}

function parseTaskInstanceRow(
  row: TaskInstanceRow,
  homeId: string,
): TaskInstance {
  if (
    !isUuid(row.id) ||
    !isUuid(row.home_id) ||
    row.home_id !== homeId ||
    !isTaskSource(row.source) ||
    !isTaskStatus(row.status) ||
    typeof row.title !== 'string' ||
    !isDate(row.created_at) ||
    !isDate(row.updated_at)
  ) {
    throw new TaskPersistenceError();
  }

  const scheduledFor = parseScheduledFor(row.scheduled_for);
  const assignedMembershipId = parseOptionalUuid(row.assigned_membership_id);
  const completedAt = parseCompletedAt(row.completed_at);

  if (row.status === 'OPEN' && completedAt !== null) {
    throw new TaskPersistenceError();
  }
  if (row.status === 'COMPLETED' && completedAt === null) {
    throw new TaskPersistenceError();
  }

  return Object.freeze({
    id: row.id,
    homeId: row.home_id,
    source: row.source,
    status: row.status,
    title: row.title,
    scheduledFor,
    assignedMembershipId,
    completedAt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function oneRow(
  rows: readonly TaskInstanceRow[],
  homeId: string,
): TaskInstance {
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new TaskPersistenceError();
  }
  return parseTaskInstanceRow(rows[0], homeId);
}

export function createTaskRepository(pool: Pool): TaskRepository {
  return Object.freeze({
    async insertManual(tx, task) {
      let rows: TaskInstanceRow[];
      try {
        rows = (
          await tx.query<TaskInstanceRow>(INSERT_MANUAL_TASK_INSTANCE_SQL, [
            task.id,
            task.homeId,
            task.title,
            task.scheduledFor,
            task.assignedMembershipId,
            task.createdAt,
          ])
        ).rows;
      } catch (error) {
        if (error instanceof TaskPersistenceError) {
          throw error;
        }
        throw new TaskPersistenceError();
      }
      return oneRow(rows, task.homeId);
    },

    async findByHomeAndId(homeId, taskId) {
      let rows: TaskInstanceRow[];
      try {
        rows = (
          await pool.query<TaskInstanceRow>(
            FIND_TASK_INSTANCE_BY_HOME_AND_ID_SQL,
            [homeId, taskId],
          )
        ).rows;
      } catch {
        throw new TaskPersistenceError();
      }
      if (rows.length === 0) {
        return null;
      }
      return oneRow(rows, homeId);
    },

    async listByHome(homeId) {
      let rows: TaskInstanceRow[];
      try {
        rows = (
          await pool.query<TaskInstanceRow>(LIST_TASK_INSTANCES_BY_HOME_SQL, [
            homeId,
          ])
        ).rows;
      } catch {
        throw new TaskPersistenceError();
      }
      return Object.freeze(
        rows.map((row) => parseTaskInstanceRow(row, homeId)),
      );
    },

    async lockByHomeAndId(tx, homeId, taskId) {
      let rows: TaskInstanceRow[];
      try {
        rows = (
          await tx.query<TaskInstanceRow>(
            LOCK_TASK_INSTANCE_BY_HOME_AND_ID_SQL,
            [homeId, taskId],
          )
        ).rows;
      } catch (error) {
        if (error instanceof TaskPersistenceError) {
          throw error;
        }
        throw new TaskPersistenceError();
      }
      if (rows.length === 0) {
        return null;
      }
      return oneRow(rows, homeId);
    },

    async completeOpenTask(tx, input) {
      let rows: TaskInstanceRow[];
      try {
        rows = (
          await tx.query<TaskInstanceRow>(COMPLETE_OPEN_TASK_INSTANCE_SQL, [
            input.homeId,
            input.taskId,
            input.completedAt,
            input.updatedAt,
          ])
        ).rows;
      } catch (error) {
        if (error instanceof TaskPersistenceError) {
          throw error;
        }
        throw new TaskPersistenceError();
      }
      if (rows.length === 0) {
        return null;
      }
      return oneRow(rows, input.homeId);
    },
  });
}
