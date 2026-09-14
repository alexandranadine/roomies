import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { lockHomeAndExactMemberships } from '../../domains/homes/lock-home-and-exact-memberships.js';
import { TaskAlreadyCompletedError } from '../../domains/tasks/errors.js';
import { TASK_COMPLETED_V1 } from '../../domains/tasks/events.js';
import { createTaskRepository } from '../../domains/tasks/repository.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import type { AppConfig } from '../../platform/config/types.js';
import { outboxWriter } from '../../platform/events/outbox-writer.js';
import { createUuidV7, systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import {
  createCompleteTask,
  createCompleteTaskFromPool,
} from './complete-task.js';
import { createCreateManualTaskFromPool } from './create-manual-task.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const TITLE_SENTINEL = 'SENTINEL_TASK_TITLE_LEAK_M64A';
const CREATED = new Date('2026-09-13T17:00:00.000Z');
const OCCURRED = new Date('2026-09-13T18:00:00.000Z');

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

function actor(input: {
  userId: string;
  membershipId: string;
  homeId: string;
  role: ActiveHomeActor['role'];
}): ActiveHomeActor {
  return { ...input };
}

async function insertUser(pool: Pool, userId: string): Promise<void> {
  await pool.query('INSERT INTO users (id, updated_at) VALUES ($1, NOW())', [
    userId,
  ]);
}

async function insertHome(
  pool: Pool,
  input: { id: string; name: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO homes (id, name, timezone, archived_at, updated_at)
     VALUES ($1, $2, 'UTC', NULL, NOW())`,
    [input.id, input.name],
  );
}

async function insertMembership(
  pool: Pool,
  input: {
    id: string;
    homeId: string;
    userId: string;
    role: 'ROOMMATE' | 'ADMIN';
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO memberships (id, home_id, user_id, role, ended_at, ended_by_membership_id)
     VALUES ($1, $2, $3, $4, NULL, NULL)`,
    [input.id, input.homeId, input.userId, input.role],
  );
}

async function insertOpenManualTask(
  pool: Pool,
  input: {
    id: string;
    homeId: string;
    title: string;
    assignedMembershipId?: string | null;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO task_instances (
       id, home_id, source, status, title, scheduled_for,
       assigned_membership_id, task_definition_id, completed_at,
       created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, 'MANUAL', 'OPEN', $3, NULL, $4::uuid,
       NULL, NULL, $5::timestamptz, $5::timestamptz
     )`,
    [
      input.id,
      input.homeId,
      input.title,
      input.assignedMembershipId ?? null,
      CREATED,
    ],
  );
}

async function cleanup(
  pool: Pool,
  input: { homeIds: string[]; userIds: string[] },
): Promise<void> {
  if (input.homeIds.length > 0) {
    await pool.query(
      'DELETE FROM activity_recipients WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query('DELETE FROM activities WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query('DELETE FROM task_instances WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query('DELETE FROM outbox_events WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query(
      'DELETE FROM membership_role_transitions WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query(
      `UPDATE memberships
       SET ended_by_membership_id = id
       WHERE home_id = ANY($1::uuid[]) AND ended_at IS NOT NULL`,
      [input.homeIds],
    );
    await pool.query(
      `DELETE FROM memberships
       WHERE home_id = ANY($1::uuid[]) AND ended_at IS NULL`,
      [input.homeIds],
    );
    const remainingMemberships = await pool.query<{ id: string }>(
      'SELECT id FROM memberships WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    for (const row of remainingMemberships.rows) {
      await pool.query(
        `UPDATE memberships
         SET ended_at = NULL, ended_by_membership_id = NULL
         WHERE id = $1`,
        [row.id],
      );
      await pool.query('DELETE FROM memberships WHERE id = $1', [row.id]);
    }
    await pool.query('DELETE FROM homes WHERE id = ANY($1)', [input.homeIds]);
  }
  if (input.userIds.length > 0) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [input.userIds]);
  }
}

type OutboxRow = {
  event_id: string;
  event_type: string;
  occurred_at: Date;
  home_id: string | null;
  payload: unknown;
};

async function taskEvents(
  pool: Pool,
  homeId: string,
): Promise<readonly OutboxRow[]> {
  const result = await pool.query<OutboxRow>(
    `SELECT event_id, event_type, occurred_at, home_id, payload
     FROM outbox_events
     WHERE home_id = $1
       AND event_type LIKE 'task%'
     ORDER BY created_at ASC, event_id ASC`,
    [homeId],
  );
  return result.rows;
}

void describe('Task outbox event production PostgreSQL', () => {
  void it(
    'uses only a dedicated safe TEST_DATABASE_URL',
    { skip: skipWithoutDatabase },
    () => {
      const url = resolveSafeDedicatedTestDatabaseUrl();
      const parsed = parseDatabaseUrl(url);
      assert.notEqual(parsed.database.toLowerCase(), 'roomies');
      assert.match(parsed.database, /(?:^|_)(?:test|ci)$/i);
    },
  );

  void it(
    'emits exactly one task.completed.v1 on success with canonical completer',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const complete = createCompleteTaskFromPool(database.pool);
      const create = createCreateManualTaskFromPool(database.pool);
      const userAlex = randomUUID();
      const userJamie = randomUUID();
      const homeId = createUuidV7();
      const alex = createUuidV7();
      const jamie = createUuidV7();
      const taskId = createUuidV7();

      try {
        await insertUser(database.pool, userAlex);
        await insertUser(database.pool, userJamie);
        await insertHome(database.pool, { id: homeId, name: 'Task events' });
        await insertMembership(database.pool, {
          id: alex,
          homeId,
          userId: userAlex,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: jamie,
          homeId,
          userId: userJamie,
          role: 'ROOMMATE',
        });
        await insertOpenManualTask(database.pool, {
          id: taskId,
          homeId,
          title: TITLE_SENTINEL,
          assignedMembershipId: alex,
        });

        const completed = await complete({
          actor: actor({
            userId: userJamie,
            membershipId: jamie,
            homeId,
            role: 'ROOMMATE',
          }),
          homeId,
          taskId,
        });
        assert.equal(completed.status, 'COMPLETED');
        assert.equal(completed.assignedMembershipId, alex);
        assert.equal(completed.completedByMembershipId, jamie);
        assert.notEqual(completed.completedByMembershipId, alex);

        const events = await taskEvents(database.pool, homeId);
        assert.equal(events.length, 1);
        assert.equal(events[0]?.event_type, TASK_COMPLETED_V1);
        assert.equal(events[0]?.home_id, homeId);
        assert.equal(
          events[0]?.occurred_at.getTime(),
          completed.completedAt?.getTime(),
        );
        assert.deepEqual(events[0]?.payload, { taskInstanceId: taskId });
        assert.deepEqual(Object.keys(events[0]?.payload ?? {}), [
          'taskInstanceId',
        ]);
        const json = JSON.stringify(events[0]?.payload);
        assert.equal(json.includes(TITLE_SENTINEL), false);
        assert.equal(json.includes(userJamie), false);
        assert.equal(json.includes(userAlex), false);
        assert.equal(json.includes(jamie), false);
        assert.equal(json.includes(alex), false);
        assert.equal(json.includes('Jamie'), false);
        assert.equal(json.includes('assigned'), false);

        await assert.rejects(
          () =>
            complete({
              actor: actor({
                userId: userJamie,
                membershipId: jamie,
                homeId,
                role: 'ROOMMATE',
              }),
              homeId,
              taskId,
            }),
          TaskAlreadyCompletedError,
        );
        assert.equal((await taskEvents(database.pool, homeId)).length, 1);

        const created = await create({
          actor: actor({
            userId: userAlex,
            membershipId: alex,
            homeId,
            role: 'ROOMMATE',
          }),
          homeId,
          title: TITLE_SENTINEL,
        });
        assert.equal((await taskEvents(database.pool, homeId)).length, 1);
        assert.equal(created.status, 'OPEN');
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userAlex, userJamie],
        });
        await database.close();
      }
    },
  );

  void it(
    'emits no event on unauthorized, conflict, or rollback',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const complete = createCompleteTaskFromPool(database.pool);
      const tasks = createTaskRepository(database.pool);
      const userA = randomUUID();
      const userB = randomUUID();
      const homeA = createUuidV7();
      const homeB = createUuidV7();
      const membershipA = createUuidV7();
      const membershipB = createUuidV7();
      const taskA = createUuidV7();
      const taskRollback = createUuidV7();

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeA, name: 'Fail A' });
        await insertHome(database.pool, { id: homeB, name: 'Fail B' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId: homeA,
          userId: userA,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId: homeB,
          userId: userB,
          role: 'ROOMMATE',
        });
        await insertOpenManualTask(database.pool, {
          id: taskA,
          homeId: homeA,
          title: TITLE_SENTINEL,
        });
        await insertOpenManualTask(database.pool, {
          id: taskRollback,
          homeId: homeA,
          title: TITLE_SENTINEL,
        });

        await assert.rejects(
          () =>
            complete({
              actor: actor({
                userId: userB,
                membershipId: membershipB,
                homeId: homeB,
                role: 'ROOMMATE',
              }),
              homeId: homeA,
              taskId: taskA,
            }),
          ConcealedNotFoundError,
        );
        assert.equal((await taskEvents(database.pool, homeA)).length, 0);
        assert.equal((await taskEvents(database.pool, homeB)).length, 0);

        await assert.rejects(
          () =>
            createCompleteTask({
              runTransaction: (work) =>
                runInReadCommittedTransaction(database.pool, work),
              lockHomeAndExactMemberships,
              tasks: {
                lockByHomeAndId: (tx, home, id) =>
                  tasks.lockByHomeAndId(tx, home, id),
                completeOpenTask: async (tx, input) => {
                  const completed = await tasks.completeOpenTask(tx, input);
                  if (completed === null) {
                    return null;
                  }
                  return completed;
                },
              },
              outbox: {
                async append(tx, event) {
                  await outboxWriter.append(tx, event);
                  throw new Error('force rollback after event');
                },
              },
              clock: { now: () => OCCURRED },
              ids: systemUuidV7,
            })({
              actor: actor({
                userId: userA,
                membershipId: membershipA,
                homeId: homeA,
                role: 'ROOMMATE',
              }),
              homeId: homeA,
              taskId: taskRollback,
            }),
          /force rollback after event/,
        );

        const leftover = await database.pool.query<{
          status: string;
          completed_at: Date | null;
          completed_by_membership_id: string | null;
        }>(
          `SELECT status, completed_at, completed_by_membership_id
           FROM task_instances WHERE id = $1`,
          [taskRollback],
        );
        assert.equal(leftover.rows[0]?.status, 'OPEN');
        assert.equal(leftover.rows[0]?.completed_at, null);
        assert.equal(leftover.rows[0]?.completed_by_membership_id, null);
        assert.equal((await taskEvents(database.pool, homeA)).length, 0);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeA, homeB],
          userIds: [userA, userB],
        });
        await database.close();
      }
    },
  );
});
