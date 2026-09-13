import type { Temporal } from '@js-temporal/polyfill';
import type { Pool } from 'pg';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { TaskPersistenceError } from './errors.js';
import {
  HOME_LOCAL_DATE_PATTERN,
  parseHomeLocalDate,
} from './home-local-date.js';
import type { DateString } from './home-local-date.js';
import { isTaskRecurrenceFrequency } from './recurrence-config.js';
import type { TaskRecurrenceFrequency } from './recurrence-cursor.js';
import type { TaskDefinition } from './task-definition.js';
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

/**
 * Membership-ending cleanup for OPEN TaskInstances. Exact Home + exact
 * Membership tenure only. COMPLETED rows keep historical assignment.
 */
export const UNASSIGN_OPEN_TASK_INSTANCES_FOR_MEMBERSHIP_SQL = `
UPDATE task_instances
SET
  assigned_membership_id = NULL,
  updated_at = $3::timestamptz
WHERE home_id = $1::uuid
  AND assigned_membership_id = $2::uuid
  AND status = 'OPEN'
`;

/**
 * Membership-ending cleanup for active TaskDefinitions. Exact Home + exact
 * Membership tenure only. Deactivated rows keep historical assignment.
 * creator_membership_id is never written.
 */
export const UNASSIGN_ACTIVE_TASK_DEFINITIONS_FOR_MEMBERSHIP_SQL = `
UPDATE task_definitions
SET
  assigned_membership_id = NULL,
  updated_at = $3::timestamptz
WHERE home_id = $1::uuid
  AND assigned_membership_id = $2::uuid
  AND deactivated_at IS NULL
`;

const TASK_DEFINITION_COLUMNS = `
id,
home_id,
title,
recurrence_frequency,
recurrence_weekday,
recurrence_day_of_month,
assigned_membership_id,
creator_membership_id,
next_occurrence_date::text AS next_occurrence_date,
next_occurrence_at,
deactivated_at,
created_at,
updated_at
`;

export const INSERT_TASK_DEFINITION_SQL = `
INSERT INTO task_definitions (
  id,
  home_id,
  title,
  assigned_membership_id,
  creator_membership_id,
  recurrence_frequency,
  recurrence_weekday,
  recurrence_day_of_month,
  next_occurrence_date,
  next_occurrence_at,
  deactivated_at,
  created_at,
  updated_at
)
VALUES (
  $1::uuid,
  $2::uuid,
  $3,
  $4::uuid,
  $5::uuid,
  $6,
  $7,
  $8,
  $9::date,
  $10::timestamptz,
  NULL,
  $11::timestamptz,
  $11::timestamptz
)
RETURNING ${TASK_DEFINITION_COLUMNS}
`;

export const LIST_TASK_DEFINITIONS_BY_HOME_SQL = `
SELECT ${TASK_DEFINITION_COLUMNS}
FROM task_definitions
WHERE home_id = $1::uuid
ORDER BY
  CASE WHEN deactivated_at IS NULL THEN 0 ELSE 1 END,
  COALESCE(deactivated_at, created_at) ASC,
  id ASC
`;

export const LOCK_TASK_DEFINITION_BY_HOME_AND_ID_SQL = `
SELECT ${TASK_DEFINITION_COLUMNS}
FROM task_definitions
WHERE home_id = $1::uuid
  AND id = $2::uuid
LIMIT 2
FOR UPDATE
`;

export const DEACTIVATE_ACTIVE_TASK_DEFINITION_SQL = `
UPDATE task_definitions
SET
  deactivated_at = $3::timestamptz,
  next_occurrence_date = NULL,
  next_occurrence_at = NULL,
  updated_at = $3::timestamptz
WHERE home_id = $1::uuid
  AND id = $2::uuid
  AND deactivated_at IS NULL
  AND next_occurrence_date IS NOT NULL
  AND next_occurrence_at IS NOT NULL
RETURNING ${TASK_DEFINITION_COLUMNS}
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

export type UnassignMembershipAssignments = Readonly<{
  homeId: string;
  membershipId: string;
  updatedAt: Date;
}>;

export type NewTaskDefinition = Readonly<{
  id: string;
  homeId: string;
  title: string;
  frequency: TaskRecurrenceFrequency;
  weekday: number | null;
  dayOfMonth: number | null;
  assignedMembershipId: string | null;
  creatorMembershipId: string;
  nextOccurrenceDate: DateString;
  nextOccurrenceAt: Temporal.Instant;
  createdAt: Date;
}>;

export type DeactivateActiveTaskDefinition = Readonly<{
  homeId: string;
  taskDefinitionId: string;
  deactivatedAt: Date;
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
  unassignOpenTasksForMembership(
    tx: TransactionContext,
    input: UnassignMembershipAssignments,
  ): Promise<number>;
  unassignActiveDefinitionsForMembership(
    tx: TransactionContext,
    input: UnassignMembershipAssignments,
  ): Promise<number>;
  insertDefinition(
    tx: TransactionContext,
    definition: NewTaskDefinition,
  ): Promise<TaskDefinition>;
  listDefinitionsByHome(homeId: string): Promise<readonly TaskDefinition[]>;
  lockDefinitionByHomeAndId(
    tx: TransactionContext,
    homeId: string,
    taskDefinitionId: string,
  ): Promise<TaskDefinition | null>;
  deactivateActiveDefinition(
    tx: TransactionContext,
    input: DeactivateActiveTaskDefinition,
  ): Promise<TaskDefinition | null>;
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

type TaskDefinitionRow = {
  id: unknown;
  home_id: unknown;
  title: unknown;
  recurrence_frequency: unknown;
  recurrence_weekday: unknown;
  recurrence_day_of_month: unknown;
  assigned_membership_id: unknown;
  creator_membership_id: unknown;
  next_occurrence_date: unknown;
  next_occurrence_at: unknown;
  deactivated_at: unknown;
  created_at: unknown;
  updated_at: unknown;
};

function parseOptionalInteger(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  throw new TaskPersistenceError();
}

function parseOptionalDateString(value: unknown): DateString | null {
  if (value === null) {
    return null;
  }
  if (typeof value === 'string' && HOME_LOCAL_DATE_PATTERN.test(value)) {
    return parseHomeLocalDate(value);
  }
  throw new TaskPersistenceError();
}

function parseOptionalDate(value: unknown): Date | null {
  if (value === null) {
    return null;
  }
  if (isDate(value)) {
    return value;
  }
  throw new TaskPersistenceError();
}

function parseTaskDefinitionRow(
  row: TaskDefinitionRow,
  homeId: string,
): TaskDefinition {
  if (
    !isUuid(row.id) ||
    !isUuid(row.home_id) ||
    row.home_id !== homeId ||
    typeof row.title !== 'string' ||
    !isTaskRecurrenceFrequency(row.recurrence_frequency) ||
    !isUuid(row.creator_membership_id) ||
    !isDate(row.created_at) ||
    !isDate(row.updated_at)
  ) {
    throw new TaskPersistenceError();
  }

  const weekday = parseOptionalInteger(row.recurrence_weekday);
  const dayOfMonth = parseOptionalInteger(row.recurrence_day_of_month);
  const assignedMembershipId = parseOptionalUuid(row.assigned_membership_id);
  const nextOccurrenceDate = parseOptionalDateString(row.next_occurrence_date);
  const nextOccurrenceAt = parseOptionalDate(row.next_occurrence_at);
  const deactivatedAt = parseOptionalDate(row.deactivated_at);

  if (deactivatedAt === null) {
    if (nextOccurrenceDate === null || nextOccurrenceAt === null) {
      throw new TaskPersistenceError();
    }
  } else if (nextOccurrenceDate !== null || nextOccurrenceAt !== null) {
    throw new TaskPersistenceError();
  }

  return Object.freeze({
    id: row.id,
    homeId: row.home_id,
    title: row.title,
    frequency: row.recurrence_frequency,
    weekday,
    dayOfMonth,
    assignedMembershipId,
    creatorMembershipId: row.creator_membership_id,
    nextOccurrenceDate,
    nextOccurrenceAt,
    deactivatedAt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function oneDefinitionRow(
  rows: readonly TaskDefinitionRow[],
  homeId: string,
): TaskDefinition {
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new TaskPersistenceError();
  }
  return parseTaskDefinitionRow(rows[0], homeId);
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

    async unassignOpenTasksForMembership(tx, input) {
      try {
        const result = await tx.query(
          UNASSIGN_OPEN_TASK_INSTANCES_FOR_MEMBERSHIP_SQL,
          [input.homeId, input.membershipId, input.updatedAt],
        );
        return result.rowCount ?? 0;
      } catch (error) {
        if (error instanceof TaskPersistenceError) {
          throw error;
        }
        throw new TaskPersistenceError();
      }
    },

    async unassignActiveDefinitionsForMembership(tx, input) {
      try {
        const result = await tx.query(
          UNASSIGN_ACTIVE_TASK_DEFINITIONS_FOR_MEMBERSHIP_SQL,
          [input.homeId, input.membershipId, input.updatedAt],
        );
        return result.rowCount ?? 0;
      } catch (error) {
        if (error instanceof TaskPersistenceError) {
          throw error;
        }
        throw new TaskPersistenceError();
      }
    },

    async insertDefinition(tx, definition) {
      let rows: TaskDefinitionRow[];
      try {
        rows = (
          await tx.query<TaskDefinitionRow>(INSERT_TASK_DEFINITION_SQL, [
            definition.id,
            definition.homeId,
            definition.title,
            definition.assignedMembershipId,
            definition.creatorMembershipId,
            definition.frequency,
            definition.weekday,
            definition.dayOfMonth,
            definition.nextOccurrenceDate,
            definition.nextOccurrenceAt.toString(),
            definition.createdAt,
          ])
        ).rows;
      } catch (error) {
        if (error instanceof TaskPersistenceError) {
          throw error;
        }
        throw new TaskPersistenceError();
      }
      return oneDefinitionRow(rows, definition.homeId);
    },

    async listDefinitionsByHome(homeId) {
      let rows: TaskDefinitionRow[];
      try {
        rows = (
          await pool.query<TaskDefinitionRow>(
            LIST_TASK_DEFINITIONS_BY_HOME_SQL,
            [homeId],
          )
        ).rows;
      } catch {
        throw new TaskPersistenceError();
      }
      return Object.freeze(
        rows.map((row) => parseTaskDefinitionRow(row, homeId)),
      );
    },

    async lockDefinitionByHomeAndId(tx, homeId, taskDefinitionId) {
      let rows: TaskDefinitionRow[];
      try {
        rows = (
          await tx.query<TaskDefinitionRow>(
            LOCK_TASK_DEFINITION_BY_HOME_AND_ID_SQL,
            [homeId, taskDefinitionId],
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
      return oneDefinitionRow(rows, homeId);
    },

    async deactivateActiveDefinition(tx, input) {
      let rows: TaskDefinitionRow[];
      try {
        rows = (
          await tx.query<TaskDefinitionRow>(
            DEACTIVATE_ACTIVE_TASK_DEFINITION_SQL,
            [input.homeId, input.taskDefinitionId, input.deactivatedAt],
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
      return oneDefinitionRow(rows, input.homeId);
    },
  });
}
