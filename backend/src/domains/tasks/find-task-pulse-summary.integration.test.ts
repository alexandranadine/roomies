import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import type { AppConfig } from '../../platform/config/types.js';
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import { parseHomeLocalDate } from './home-local-date.js';
import { createTaskRepository } from './repository.js';
import { findTaskPulseSummary } from './find-task-pulse-summary.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const OCCURRED = new Date('2026-09-12T18:00:00.000Z');
const TODAY = parseHomeLocalDate('2026-09-14');
const YESTERDAY = parseHomeLocalDate('2026-09-13');
const TOMORROW = parseHomeLocalDate('2026-09-15');

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

async function insertUser(pool: Pool, userId: string): Promise<void> {
  await pool.query('INSERT INTO users (id, updated_at) VALUES ($1, NOW())', [
    userId,
  ]);
}

async function insertHome(
  pool: Pool,
  input: { id: string; name: string; timezone?: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO homes (id, name, timezone, archived_at, updated_at)
     VALUES ($1, $2, $3, NULL, NOW())`,
    [input.id, input.name, input.timezone ?? 'UTC'],
  );
}

async function insertMembership(
  pool: Pool,
  input: {
    id: string;
    homeId: string;
    userId: string;
    role: 'ROOMMATE' | 'ADMIN';
    ended?: boolean;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO memberships (id, home_id, user_id, role, ended_at, ended_by_membership_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.id,
      input.homeId,
      input.userId,
      input.role,
      input.ended === true ? new Date() : null,
      input.ended === true ? input.id : null,
    ],
  );
}

async function cleanup(
  pool: Pool,
  input: { userIds: string[]; homeIds: string[] },
): Promise<void> {
  if (input.homeIds.length > 0) {
    await pool.query('DELETE FROM task_instances WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query('DELETE FROM task_definitions WHERE home_id = ANY($1)', [
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
    const remaining = await pool.query<{ id: string }>(
      'SELECT id FROM memberships WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    for (const row of remaining.rows) {
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

void describe('findTaskPulseSummary PostgreSQL', () => {
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
    'counts only requester-relevant OPEN Tasks with Home-local dates',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const databaseUrl = resolveSafeDedicatedTestDatabaseUrl();
      const database = createDatabasePool(testConfig(databaseUrl));
      const tasks = createTaskRepository(database.pool);
      const userIds: string[] = [];
      const homeIds: string[] = [];

      try {
        const homeId = createUuidV7();
        const otherHome = createUuidV7();
        const alexUser = createUuidV7();
        const jamieUser = createUuidV7();
        const alexA = createUuidV7();
        const alexB = createUuidV7();
        const jamie = createUuidV7();
        homeIds.push(homeId, otherHome);
        userIds.push(alexUser, jamieUser);

        await insertUser(database.pool, alexUser);
        await insertUser(database.pool, jamieUser);
        await insertHome(database.pool, {
          id: homeId,
          name: 'Pulse Tasks',
          timezone: 'America/Los_Angeles',
        });
        await insertHome(database.pool, { id: otherHome, name: 'Other' });
        await insertMembership(database.pool, {
          id: alexA,
          homeId,
          userId: alexUser,
          role: 'ROOMMATE',
          ended: true,
        });
        await insertMembership(database.pool, {
          id: alexB,
          homeId,
          userId: alexUser,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: jamie,
          homeId,
          userId: jamieUser,
          role: 'ROOMMATE',
        });

        const empty = await runInReadCommittedTransaction(database.pool, (tx) =>
          findTaskPulseSummary(tx, {
            homeId,
            requesterMembershipId: alexB,
            homeLocalDate: TODAY,
          }),
        );
        assert.deepEqual(empty, {
          assignedOpenCount: 0,
          unassignedOpenCount: 0,
          dueTodayRelevantCount: 0,
          overdueRelevantCount: 0,
        });

        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await tasks.insertManual(tx, {
            id: createUuidV7(),
            homeId,
            title: 'Assigned to Alex B',
            scheduledFor: null,
            assignedMembershipId: alexB,
            createdAt: OCCURRED,
          });
          await tasks.insertManual(tx, {
            id: createUuidV7(),
            homeId,
            title: 'Assigned to Jamie',
            scheduledFor: TODAY,
            assignedMembershipId: jamie,
            createdAt: OCCURRED,
          });
          await tasks.insertManual(tx, {
            id: createUuidV7(),
            homeId,
            title: 'Unassigned open',
            scheduledFor: null,
            assignedMembershipId: null,
            createdAt: OCCURRED,
          });
          const completed = await tasks.insertManual(tx, {
            id: createUuidV7(),
            homeId,
            title: 'Completed assigned',
            scheduledFor: TODAY,
            assignedMembershipId: alexB,
            createdAt: OCCURRED,
          });
          await tasks.completeOpenTask(tx, {
            homeId,
            taskId: completed.id,
            completedAt: OCCURRED,
            completedByMembershipId: alexB,
            updatedAt: OCCURRED,
          });
          await tasks.insertManual(tx, {
            id: createUuidV7(),
            homeId,
            title: 'Alex due today',
            scheduledFor: TODAY,
            assignedMembershipId: alexB,
            createdAt: OCCURRED,
          });
          await tasks.insertManual(tx, {
            id: createUuidV7(),
            homeId,
            title: 'Unassigned due today',
            scheduledFor: TODAY,
            assignedMembershipId: null,
            createdAt: OCCURRED,
          });
          await tasks.insertManual(tx, {
            id: createUuidV7(),
            homeId,
            title: 'Alex overdue',
            scheduledFor: YESTERDAY,
            assignedMembershipId: alexB,
            createdAt: OCCURRED,
          });
          await tasks.insertManual(tx, {
            id: createUuidV7(),
            homeId,
            title: 'Alex future',
            scheduledFor: TOMORROW,
            assignedMembershipId: alexB,
            createdAt: OCCURRED,
          });
          await tasks.insertManual(tx, {
            id: createUuidV7(),
            homeId,
            title: 'Historical A assignment',
            scheduledFor: TODAY,
            assignedMembershipId: alexA,
            createdAt: OCCURRED,
          });
          await tasks.insertManual(tx, {
            id: createUuidV7(),
            homeId: otherHome,
            title: 'Other home',
            scheduledFor: TODAY,
            assignedMembershipId: null,
            createdAt: OCCURRED,
          });
        });

        const summary = await runInReadCommittedTransaction(
          database.pool,
          (tx) =>
            findTaskPulseSummary(tx, {
              homeId,
              requesterMembershipId: alexB,
              homeLocalDate: TODAY,
            }),
        );
        assert.deepEqual(summary, {
          assignedOpenCount: 4,
          unassignedOpenCount: 2,
          dueTodayRelevantCount: 2,
          overdueRelevantCount: 1,
        });
      } finally {
        await cleanup(database.pool, { userIds, homeIds });
        await database.close();
      }
    },
  );
});
