import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { tryLockHomeAndExactMemberships } from '../../domains/homes/lock-home-and-exact-memberships.js';
import { TaskPersistenceError } from '../../domains/tasks/errors.js';
import {
  createTaskRepository,
  FIND_NEXT_DUE_TASK_DEFINITION_CANDIDATE_SQL,
  type TaskRepository,
} from '../../domains/tasks/repository.js';
import type { AppConfig } from '../../platform/config/types.js';
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import { createProcessDueRecurringTasks } from './process-due-recurring-tasks.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const WORKER_NOW = new Date('2026-09-12T12:00:00.000Z');

function testConfig(databaseUrl: string): AppConfig {
  return {
    appEnv: 'test',
    port: 3000,
    databaseUrl,
    authBaseUrl: 'http://localhost:3000',
    authSecret: 'roomies_test_secret_32_chars_minimum_value',
    secureAuthCookies: false,
    frontendOrigin: 'http://localhost:5173',
    trustedOrigins: ['http://localhost:5173'],
    trustProxyHops: 0,
  };
}

type Fixture = Readonly<{
  userId: string;
  homeId: string;
  membershipId: string;
}>;

async function insertFixture(
  pool: Pool,
  input: {
    name: string;
    timezone?: string;
    archivedAt?: Date | null;
    endedAt?: Date | null;
  },
): Promise<Fixture> {
  const userId = randomUUID();
  const homeId = randomUUID();
  const membershipId = randomUUID();
  await pool.query('INSERT INTO users (id, updated_at) VALUES ($1, NOW())', [
    userId,
  ]);
  await pool.query(
    `INSERT INTO homes (id, name, timezone, archived_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [homeId, input.name, input.timezone ?? 'UTC', input.archivedAt ?? null],
  );
  await pool.query(
    `INSERT INTO memberships (id, home_id, user_id, role, ended_at)
     VALUES ($1, $2, $3, 'ADMIN', $4)`,
    [membershipId, homeId, userId, input.endedAt ?? null],
  );
  return { userId, homeId, membershipId };
}

async function insertDefinition(
  pool: Pool,
  input: {
    id?: string;
    homeId: string;
    creatorMembershipId: string;
    assignedMembershipId?: string | null;
    title: string;
    frequency?: 'DAILY' | 'WEEKLY' | 'MONTHLY';
    weekday?: number | null;
    dayOfMonth?: number | null;
    nextOccurrenceDate: string | null;
    nextOccurrenceAt: Date | null;
    deactivatedAt?: Date | null;
  },
): Promise<string> {
  const id = input.id ?? randomUUID();
  await pool.query(
    `INSERT INTO task_definitions (
       id, home_id, title, assigned_membership_id, creator_membership_id,
       recurrence_frequency, recurrence_weekday, recurrence_day_of_month,
       next_occurrence_date, next_occurrence_at, deactivated_at,
       created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, $11,
       TIMESTAMPTZ '2026-01-01T00:00:00Z',
       TIMESTAMPTZ '2026-01-01T00:00:00Z'
     )`,
    [
      id,
      input.homeId,
      input.title,
      input.assignedMembershipId ?? null,
      input.creatorMembershipId,
      input.frequency ?? 'DAILY',
      input.weekday ?? null,
      input.dayOfMonth ?? null,
      input.nextOccurrenceDate,
      input.nextOccurrenceAt,
      input.deactivatedAt ?? null,
    ],
  );
  return id;
}

async function cleanup(
  pool: Pool,
  fixtures: readonly Fixture[],
): Promise<void> {
  const homeIds = fixtures.map((fixture) => fixture.homeId);
  const userIds = fixtures.map((fixture) => fixture.userId);
  if (homeIds.length > 0) {
    await pool.query('DELETE FROM task_instances WHERE home_id = ANY($1)', [
      homeIds,
    ]);
    await pool.query('DELETE FROM task_definitions WHERE home_id = ANY($1)', [
      homeIds,
    ]);
    await pool.query('DELETE FROM outbox_events WHERE home_id = ANY($1)', [
      homeIds,
    ]);
    await pool.query('DELETE FROM memberships WHERE home_id = ANY($1)', [
      homeIds,
    ]);
    await pool.query('DELETE FROM homes WHERE id = ANY($1)', [homeIds]);
  }
  if (userIds.length > 0) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
  }
}

function processor(
  pool: Pool,
  tasks: TaskRepository = createTaskRepository(pool),
) {
  return createProcessDueRecurringTasks({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    tryLockHomeAndExactMemberships,
    tasks,
    clock: { now: () => WORKER_NOW },
    ids: { next: createUuidV7 },
  });
}

void describe('processDueRecurringTasks behavior PostgreSQL', () => {
  void it(
    'uses only a dedicated safe TEST_DATABASE_URL',
    { skip: skipWithoutDatabase },
    () => {
      const parsed = parseDatabaseUrl(resolveSafeDedicatedTestDatabaseUrl());
      assert.notEqual(parsed.database.toLowerCase(), 'roomies');
      assert.match(parsed.database, /(?:^|_)(?:test|ci)$/i);
    },
  );

  void it(
    'uses the existing worker due index for ordered candidate discovery',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixtures: Fixture[] = [];
      const client = await database.pool.connect();
      try {
        // Seed representative due volume so the planner prefers the worker due
        // index over home-scoped indexes that win at trivial one-row scale.
        for (let homeIndex = 0; homeIndex < 20; homeIndex += 1) {
          const fixture = await insertFixture(database.pool, {
            name: `Due query plan ${String(homeIndex)}`,
          });
          fixtures.push(fixture);
          for (
            let definitionIndex = 0;
            definitionIndex < 10;
            definitionIndex += 1
          ) {
            const day = 1 + (definitionIndex % 10);
            const occurrenceDate = `2026-09-${String(day).padStart(2, '0')}`;
            await insertDefinition(database.pool, {
              homeId: fixture.homeId,
              creatorMembershipId: fixture.membershipId,
              title: `Plan probe ${String(homeIndex)}-${String(definitionIndex)}`,
              nextOccurrenceDate: occurrenceDate,
              nextOccurrenceAt: new Date(`${occurrenceDate}T00:00:00.000Z`),
            });
          }
        }
        await client.query('ANALYZE task_definitions');
        await client.query('ANALYZE homes');

        await client.query('BEGIN');
        const plan = await client.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN (COSTS OFF) ${FIND_NEXT_DUE_TASK_DEFINITION_CANDIDATE_SQL}`,
          [WORKER_NOW, []],
        );
        assert.match(
          plan.rows.map((row) => row['QUERY PLAN']).join('\n'),
          /task_definitions_worker_due_idx_/,
        );
        await client.query('ROLLBACK');
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
        await cleanup(database.pool, fixtures);
        await database.close();
      }
    },
  );

  void it(
    'generates catch-up occurrences with definition snapshots and a bounded cursor',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixtures: Fixture[] = [];
      try {
        const fixture = await insertFixture(database.pool, {
          name: 'Recurring catch-up',
        });
        fixtures.push(fixture);
        const definitionId = await insertDefinition(database.pool, {
          homeId: fixture.homeId,
          creatorMembershipId: fixture.membershipId,
          assignedMembershipId: fixture.membershipId,
          title: 'Snapshot title',
          nextOccurrenceDate: '2026-09-10',
          nextOccurrenceAt: new Date('2026-09-10T00:00:00.000Z'),
        });

        const result = await processor(database.pool)({
          maxOccurrencesPerDefinition: 2,
        });
        assert.deepEqual(result, {
          definitionsProcessed: 1,
          occurrencesGenerated: 2,
          occurrencesReconciled: 0,
          moreDueWorkLikely: true,
        });

        await database.pool.query(
          `UPDATE task_definitions
           SET title = 'Changed later', assigned_membership_id = NULL
           WHERE id = $1`,
          [definitionId],
        );
        const second = await processor(database.pool)();
        assert.equal(second.occurrencesGenerated, 1);
        assert.equal(second.moreDueWorkLikely, false);

        const occurrences = await database.pool.query<{
          source: string;
          status: string;
          title: string;
          scheduled_for: string;
          assigned_membership_id: string | null;
          created_at: Date;
          updated_at: Date;
        }>(
          `SELECT source, status, title,
                  scheduled_for::text AS scheduled_for,
                  assigned_membership_id, created_at, updated_at
           FROM task_instances
           WHERE task_definition_id = $1
           ORDER BY scheduled_for`,
          [definitionId],
        );
        assert.deepEqual(
          occurrences.rows.map((row) => ({
            source: row.source,
            status: row.status,
            title: row.title,
            date: row.scheduled_for,
            assignee: row.assigned_membership_id,
            createdAt: row.created_at.toISOString(),
            updatedAt: row.updated_at.toISOString(),
          })),
          [
            {
              source: 'RECURRING',
              status: 'OPEN',
              title: 'Snapshot title',
              date: '2026-09-10',
              assignee: fixture.membershipId,
              createdAt: WORKER_NOW.toISOString(),
              updatedAt: WORKER_NOW.toISOString(),
            },
            {
              source: 'RECURRING',
              status: 'OPEN',
              title: 'Snapshot title',
              date: '2026-09-11',
              assignee: fixture.membershipId,
              createdAt: WORKER_NOW.toISOString(),
              updatedAt: WORKER_NOW.toISOString(),
            },
            {
              source: 'RECURRING',
              status: 'OPEN',
              title: 'Changed later',
              date: '2026-09-12',
              assignee: null,
              createdAt: WORKER_NOW.toISOString(),
              updatedAt: WORKER_NOW.toISOString(),
            },
          ],
        );
        const cursor = await database.pool.query<{
          next_occurrence_date: string;
          next_occurrence_at: Date;
          updated_at: Date;
        }>(
          `SELECT next_occurrence_date::text AS next_occurrence_date,
                  next_occurrence_at, updated_at
           FROM task_definitions WHERE id = $1`,
          [definitionId],
        );
        assert.equal(cursor.rows[0]?.next_occurrence_date, '2026-09-13');
        assert.equal(
          cursor.rows[0]?.next_occurrence_at.toISOString(),
          '2026-09-13T00:00:00.000Z',
        );
        assert.equal(
          cursor.rows[0]?.updated_at.toISOString(),
          WORKER_NOW.toISOString(),
        );
        const taskEvents = await database.pool.query<{ count: number }>(
          `SELECT count(*)::int AS count
           FROM outbox_events
           WHERE home_id = $1 AND event_type LIKE 'task.%'`,
          [fixture.homeId],
        );
        assert.equal(taskEvents.rows[0]?.count, 0);
      } finally {
        await cleanup(database.pool, fixtures);
        await database.close();
      }
    },
  );

  void it(
    'reconciles an existing occurrence and ignores archived or deactivated definitions',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixtures: Fixture[] = [];
      try {
        const active = await insertFixture(database.pool, {
          name: 'Idempotency',
        });
        const archived = await insertFixture(database.pool, {
          name: 'Archived recurrence',
          archivedAt: new Date('2026-09-01T00:00:00.000Z'),
        });
        fixtures.push(active, archived);
        const activeDefinition = await insertDefinition(database.pool, {
          homeId: active.homeId,
          creatorMembershipId: active.membershipId,
          title: 'Existing',
          nextOccurrenceDate: '2026-09-12',
          nextOccurrenceAt: new Date('2026-09-12T00:00:00.000Z'),
        });
        const deactivatedDefinition = await insertDefinition(database.pool, {
          homeId: active.homeId,
          creatorMembershipId: active.membershipId,
          title: 'Deactivated',
          nextOccurrenceDate: null,
          nextOccurrenceAt: null,
          deactivatedAt: new Date('2026-09-11T00:00:00.000Z'),
        });
        const archivedDefinition = await insertDefinition(database.pool, {
          homeId: archived.homeId,
          creatorMembershipId: archived.membershipId,
          title: 'Archived',
          nextOccurrenceDate: '2026-09-12',
          nextOccurrenceAt: new Date('2026-09-12T00:00:00.000Z'),
        });
        const existingId = randomUUID();
        await database.pool.query(
          `INSERT INTO task_instances (
             id, home_id, source, status, title, scheduled_for,
             assigned_membership_id, task_definition_id, completed_at,
             created_at, updated_at
           ) VALUES (
             $1, $2, 'RECURRING', 'OPEN', 'Original snapshot',
             DATE '2026-09-12', NULL, $3, NULL,
             TIMESTAMPTZ '2026-09-12T01:00:00Z',
             TIMESTAMPTZ '2026-09-12T01:00:00Z'
           )`,
          [existingId, active.homeId, activeDefinition],
        );

        const result = await processor(database.pool)();
        assert.deepEqual(result, {
          definitionsProcessed: 1,
          occurrencesGenerated: 0,
          occurrencesReconciled: 1,
          moreDueWorkLikely: false,
        });
        const rows = await database.pool.query<{
          id: string;
          title: string;
          task_definition_id: string;
        }>(
          `SELECT id, title, task_definition_id
           FROM task_instances WHERE home_id = ANY($1)`,
          [[active.homeId, archived.homeId]],
        );
        assert.deepEqual(rows.rows, [
          {
            id: existingId,
            title: 'Original snapshot',
            task_definition_id: activeDefinition,
          },
        ]);
        const states = await database.pool.query<{
          id: string;
          next_occurrence_date: string | null;
        }>(
          `SELECT id, next_occurrence_date::text AS next_occurrence_date
           FROM task_definitions WHERE id = ANY($1) ORDER BY id`,
          [[activeDefinition, deactivatedDefinition, archivedDefinition]],
        );
        const byId = new Map(
          states.rows.map((row) => [row.id, row.next_occurrence_date]),
        );
        assert.equal(byId.get(activeDefinition), '2026-09-13');
        assert.equal(byId.get(deactivatedDefinition), null);
        assert.equal(byId.get(archivedDefinition), '2026-09-12');
      } finally {
        await cleanup(database.pool, fixtures);
        await database.close();
      }
    },
  );

  void it(
    'persists weekly and monthly catch-up without short-month drift',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixtures: Fixture[] = [];
      try {
        const monthly = await insertFixture(database.pool, {
          name: 'Monthly catch-up',
        });
        const weekly = await insertFixture(database.pool, {
          name: 'Weekly catch-up',
        });
        fixtures.push(monthly, weekly);
        const monthlyDefinition = await insertDefinition(database.pool, {
          homeId: monthly.homeId,
          creatorMembershipId: monthly.membershipId,
          title: 'Month end',
          frequency: 'MONTHLY',
          dayOfMonth: 31,
          nextOccurrenceDate: '2026-01-31',
          nextOccurrenceAt: new Date('2026-01-31T00:00:00.000Z'),
        });
        const weeklyDefinition = await insertDefinition(database.pool, {
          homeId: weekly.homeId,
          creatorMembershipId: weekly.membershipId,
          title: 'Every Monday',
          frequency: 'WEEKLY',
          weekday: 1,
          nextOccurrenceDate: '2026-08-31',
          nextOccurrenceAt: new Date('2026-08-31T00:00:00.000Z'),
        });
        const tasks = createTaskRepository(database.pool);
        const processAt = (now: Date) =>
          createProcessDueRecurringTasks({
            runTransaction: (work) =>
              runInReadCommittedTransaction(database.pool, work),
            tryLockHomeAndExactMemberships,
            tasks,
            clock: { now: () => now },
            ids: { next: createUuidV7 },
          });

        await processAt(new Date('2026-03-31T00:00:00.000Z'))({
          maxDefinitions: 1,
        });
        const monthlyDates = await database.pool.query<{
          scheduled_for: string;
        }>(
          `SELECT scheduled_for::text AS scheduled_for
           FROM task_instances
           WHERE task_definition_id = $1
           ORDER BY scheduled_for`,
          [monthlyDefinition],
        );
        assert.deepEqual(
          monthlyDates.rows.map((row) => row.scheduled_for),
          ['2026-01-31', '2026-02-28', '2026-03-31'],
        );
        await database.pool.query(
          `UPDATE task_definitions
           SET deactivated_at = $2,
               next_occurrence_date = NULL,
               next_occurrence_at = NULL,
               updated_at = $2
           WHERE id = $1`,
          [monthlyDefinition, new Date('2026-04-01T00:00:00.000Z')],
        );

        await processAt(new Date('2026-09-14T00:00:00.000Z'))();
        const weeklyDates = await database.pool.query<{
          scheduled_for: string;
        }>(
          `SELECT scheduled_for::text AS scheduled_for
           FROM task_instances
           WHERE task_definition_id = $1
           ORDER BY scheduled_for`,
          [weeklyDefinition],
        );
        assert.deepEqual(
          weeklyDates.rows.map((row) => row.scheduled_for),
          ['2026-08-31', '2026-09-07', '2026-09-14'],
        );
      } finally {
        await cleanup(database.pool, fixtures);
        await database.close();
      }
    },
  );

  void it(
    'preserves Pacific/Apia logical dates across the skipped civil day',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixtures: Fixture[] = [];
      try {
        const fixture = await insertFixture(database.pool, {
          name: 'Apia recurrence',
          timezone: 'Pacific/Apia',
        });
        fixtures.push(fixture);
        const definitionId = await insertDefinition(database.pool, {
          homeId: fixture.homeId,
          creatorMembershipId: fixture.membershipId,
          title: 'Skipped day',
          nextOccurrenceDate: '2011-12-30',
          nextOccurrenceAt: new Date('2011-12-30T10:00:00.000Z'),
        });
        const apiaNow = new Date('2011-12-30T10:00:00.000Z');
        const tasks = createTaskRepository(database.pool);
        const process = createProcessDueRecurringTasks({
          runTransaction: (work) =>
            runInReadCommittedTransaction(database.pool, work),
          tryLockHomeAndExactMemberships,
          tasks,
          clock: { now: () => apiaNow },
          ids: { next: createUuidV7 },
        });

        const result = await process();
        assert.equal(result.occurrencesGenerated, 2);
        const dates = await database.pool.query<{ scheduled_for: string }>(
          `SELECT scheduled_for::text AS scheduled_for
           FROM task_instances
           WHERE task_definition_id = $1
           ORDER BY scheduled_for`,
          [definitionId],
        );
        assert.deepEqual(
          dates.rows.map((row) => row.scheduled_for),
          ['2011-12-30', '2011-12-31'],
        );
        const cursor = await database.pool.query<{
          next_occurrence_date: string;
          next_occurrence_at: Date;
        }>(
          `SELECT next_occurrence_date::text AS next_occurrence_date,
                  next_occurrence_at
           FROM task_definitions WHERE id = $1`,
          [definitionId],
        );
        assert.equal(cursor.rows[0]?.next_occurrence_date, '2012-01-01');
        assert.equal(
          cursor.rows[0]?.next_occurrence_at.toISOString(),
          '2011-12-31T10:00:00.000Z',
        );
      } finally {
        await cleanup(database.pool, fixtures);
        await database.close();
      }
    },
  );

  void it(
    'rolls back an inserted occurrence and cursor when an injected wrapper fails',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixtures: Fixture[] = [];
      try {
        const fixture = await insertFixture(database.pool, {
          name: 'Rollback recurrence',
        });
        fixtures.push(fixture);
        const definitionId = await insertDefinition(database.pool, {
          homeId: fixture.homeId,
          creatorMembershipId: fixture.membershipId,
          title: 'Rollback',
          nextOccurrenceDate: '2026-09-12',
          nextOccurrenceAt: new Date('2026-09-12T00:00:00.000Z'),
        });
        const inner = createTaskRepository(database.pool);
        const injected: TaskRepository = {
          ...inner,
          async insertRecurringOccurrence(tx, occurrence) {
            await inner.insertRecurringOccurrence(tx, occurrence);
            throw new Error('injected failure after occurrence insert');
          },
        };

        await assert.rejects(
          () => processor(database.pool, injected)(),
          /injected failure after occurrence insert/,
        );
        const instances = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM task_instances WHERE task_definition_id = $1`,
          [definitionId],
        );
        assert.equal(instances.rows[0]?.count, '0');
        const cursor = await database.pool.query<{
          next_occurrence_date: string;
          next_occurrence_at: Date;
        }>(
          `SELECT next_occurrence_date::text AS next_occurrence_date,
                  next_occurrence_at
           FROM task_definitions WHERE id = $1`,
          [definitionId],
        );
        assert.equal(cursor.rows[0]?.next_occurrence_date, '2026-09-12');
        assert.equal(
          cursor.rows[0]?.next_occurrence_at.toISOString(),
          '2026-09-12T00:00:00.000Z',
        );
      } finally {
        await cleanup(database.pool, fixtures);
        await database.close();
      }
    },
  );

  void it(
    'does not reconcile an unrelated instance primary-key conflict',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixtures: Fixture[] = [];
      try {
        const fixture = await insertFixture(database.pool, {
          name: 'Unexpected insert constraint',
        });
        fixtures.push(fixture);
        const definitionId = await insertDefinition(database.pool, {
          homeId: fixture.homeId,
          creatorMembershipId: fixture.membershipId,
          title: 'Unexpected conflict',
          nextOccurrenceDate: '2026-09-12',
          nextOccurrenceAt: new Date('2026-09-12T00:00:00.000Z'),
        });
        const collidingId = createUuidV7();
        await database.pool.query(
          `INSERT INTO task_instances (
             id, home_id, source, status, title, scheduled_for,
             assigned_membership_id, task_definition_id, completed_at,
             created_at, updated_at
           ) VALUES (
             $1, $2, 'MANUAL', 'OPEN', 'Existing unrelated row', NULL,
             NULL, NULL, NULL, $3, $3
           )`,
          [collidingId, fixture.homeId, WORKER_NOW],
        );
        const tasks = createTaskRepository(database.pool);
        const process = createProcessDueRecurringTasks({
          runTransaction: (work) =>
            runInReadCommittedTransaction(database.pool, work),
          tryLockHomeAndExactMemberships,
          tasks,
          clock: { now: () => WORKER_NOW },
          ids: { next: () => collidingId },
        });

        await assert.rejects(() => process(), TaskPersistenceError);
        const generated = await database.pool.query<{ count: number }>(
          `SELECT count(*)::int AS count
           FROM task_instances WHERE task_definition_id = $1`,
          [definitionId],
        );
        assert.equal(generated.rows[0]?.count, 0);
        const cursor = await database.pool.query<{
          next_occurrence_date: string;
        }>(
          `SELECT next_occurrence_date::text AS next_occurrence_date
           FROM task_definitions WHERE id = $1`,
          [definitionId],
        );
        assert.equal(cursor.rows[0]?.next_occurrence_date, '2026-09-12');
      } finally {
        await cleanup(database.pool, fixtures);
        await database.close();
      }
    },
  );
});
