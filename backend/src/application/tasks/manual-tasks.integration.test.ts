import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createTaskRepository } from '../../domains/tasks/repository.js';
import { toTaskDto } from '../../domains/tasks/task-dto.js';
import type { AppConfig } from '../../platform/config/types.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  InvalidRequestError,
} from '../../platform/authz/errors.js';
import { createCreateManualTaskFromPool } from './create-manual-task.js';
import { createListHomeTasksFromPool } from './list-home-tasks.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OCCURRED = new Date('2026-09-12T18:00:00.000Z');

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
  input: { id: string; name: string; archived?: boolean },
): Promise<void> {
  await pool.query(
    `INSERT INTO homes (id, name, timezone, archived_at, updated_at)
     VALUES ($1, $2, 'UTC', $3, NOW())`,
    [input.id, input.name, input.archived === true ? new Date() : null],
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
    `INSERT INTO memberships (id, home_id, user_id, role, ended_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      input.id,
      input.homeId,
      input.userId,
      input.role,
      input.ended === true ? new Date() : null,
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
    await pool.query('DELETE FROM memberships WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query('DELETE FROM homes WHERE id = ANY($1)', [input.homeIds]);
  }
  if (input.userIds.length > 0) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [input.userIds]);
  }
}

function roommate(
  homeId: string,
  membershipId: string,
  userId: string,
): ActiveHomeActor {
  return {
    userId,
    membershipId,
    homeId,
    role: 'ROOMMATE',
  };
}

void describe('manual Tasks PostgreSQL', () => {
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
    'round-trips DATE, assignment, isolation, ordering, and concurrent creates',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const create = createCreateManualTaskFromPool(database.pool);
      const list = createListHomeTasksFromPool(database.pool);
      const tasks = createTaskRepository(database.pool);

      const userA = randomUUID();
      const userB = randomUUID();
      const homeA = createUuidV7();
      const homeB = createUuidV7();
      const membershipA = createUuidV7();
      const membershipB = createUuidV7();
      const endedMembership = createUuidV7();
      const otherMembership = createUuidV7();
      const userIds = [userA, userB];
      const homeIds = [homeA, homeB];

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeA, name: 'Home A' });
        await insertHome(database.pool, { id: homeB, name: 'Home B' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId: homeA,
          userId: userA,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId: homeA,
          userId: userB,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: endedMembership,
          homeId: homeA,
          userId: userA,
          role: 'ROOMMATE',
          ended: true,
        });
        await insertMembership(database.pool, {
          id: otherMembership,
          homeId: homeB,
          userId: userB,
          role: 'ROOMMATE',
        });

        const actorA = roommate(homeA, membershipA, userA);
        const actorB = {
          userId: userB,
          membershipId: membershipB,
          homeId: homeA,
          role: 'ADMIN' as const,
        };
        const undated = await create({
          actor: actorA,
          homeId: homeA,
          title: 'Undated chore',
        });
        const dated = await create({
          actor: actorA,
          homeId: homeA,
          title: 'Dated chore',
          scheduledFor: '2026-09-15',
        });
        const assigned = await create({
          actor: actorB,
          homeId: homeA,
          title: 'Assigned chore',
          assignedMembershipId: membershipA,
          scheduledFor: '2026-09-16',
        });

        assert.match(undated.id, UUID_V7);
        assert.match(dated.id, UUID_V7);
        assert.notEqual(undated.id, dated.id);
        assert.equal(undated.source, 'MANUAL');
        assert.equal(undated.status, 'OPEN');
        assert.equal(undated.completedAt, null);
        assert.equal(undated.scheduledFor, null);
        assert.equal(dated.scheduledFor, '2026-09-15');
        assert.equal(assigned.assignedMembershipId, membershipA);

        const datedRow = await database.pool.query<{
          scheduled_for: unknown;
          source: string;
          status: string;
          task_definition_id: string | null;
          completed_at: Date | null;
        }>(
          `SELECT scheduled_for::text AS scheduled_for, source, status,
                  task_definition_id, completed_at
           FROM task_instances WHERE id = $1`,
          [dated.id],
        );
        assert.equal(datedRow.rows[0]?.scheduled_for, '2026-09-15');
        assert.equal(datedRow.rows[0]?.source, 'MANUAL');
        assert.equal(datedRow.rows[0]?.status, 'OPEN');
        assert.equal(datedRow.rows[0]?.task_definition_id, null);
        assert.equal(datedRow.rows[0]?.completed_at, null);
        const scheduledFor = datedRow.rows[0]?.scheduled_for;
        assert.equal(typeof scheduledFor, 'string');
        assert.notEqual(
          Object.prototype.toString.call(scheduledFor),
          '[object Date]',
        );

        const undatedRow = await database.pool.query<{
          scheduled_for: string | null;
        }>(
          `SELECT scheduled_for::text AS scheduled_for
           FROM task_instances WHERE id = $1`,
          [undated.id],
        );
        assert.equal(undatedRow.rows[0]?.scheduled_for, null);

        const loaded = await tasks.findByHomeAndId(homeA, dated.id);
        assert.equal(loaded?.scheduledFor, '2026-09-15');

        await assert.rejects(
          () =>
            create({
              actor: actorA,
              homeId: homeA,
              title: 'Ended assignee',
              assignedMembershipId: endedMembership,
            }),
          InvalidRequestError,
        );
        await assert.rejects(
          () =>
            create({
              actor: actorA,
              homeId: homeA,
              title: 'Cross-home assignee',
              assignedMembershipId: otherMembership,
            }),
          InvalidRequestError,
        );
        await assert.rejects(
          () =>
            create({
              actor: actorA,
              homeId: homeA,
              title: 'Unknown assignee',
              assignedMembershipId: createUuidV7(),
            }),
          InvalidRequestError,
        );

        const afterRejected = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM task_instances
           WHERE home_id = $1 AND title = ANY($2)`,
          [
            homeA,
            ['Ended assignee', 'Cross-home assignee', 'Unknown assignee'],
          ],
        );
        assert.equal(afterRejected.rows[0]?.count, '0');

        await assert.rejects(
          () =>
            create({
              actor: roommate(homeA, endedMembership, userA),
              homeId: homeA,
              title: 'Stale tenure',
            }),
          ConcealedNotFoundError,
        );
        const afterStale = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM task_instances
           WHERE home_id = $1 AND title = 'Stale tenure'`,
          [homeA],
        );
        assert.equal(afterStale.rows[0]?.count, '0');

        const [firstConcurrent, secondConcurrent] = await Promise.all([
          create({
            actor: actorA,
            homeId: homeA,
            title: 'Concurrent same title',
            scheduledFor: '2026-09-17',
          }),
          create({
            actor: actorA,
            homeId: homeA,
            title: 'Concurrent same title',
            scheduledFor: '2026-09-17',
          }),
        ]);
        assert.notEqual(firstConcurrent.id, secondConcurrent.id);
        assert.match(firstConcurrent.id, UUID_V7);
        assert.match(secondConcurrent.id, UUID_V7);
        const concurrentRows = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM task_instances
           WHERE home_id = $1 AND title = $2`,
          [homeA, 'Concurrent same title'],
        );
        assert.equal(concurrentRows.rows[0]?.count, '2');

        const definitionId = createUuidV7();
        const recurringId = createUuidV7();
        const completedId = createUuidV7();
        const earlyDatedId = createUuidV7();
        await database.pool.query(
          `INSERT INTO task_definitions (
             id, home_id, title, creator_membership_id, recurrence_frequency,
             next_occurrence_date, next_occurrence_at, created_at, updated_at
           ) VALUES ($1, $2, 'Definition title should not render', $3, 'DAILY', DATE '2026-09-13', $4, $5, $5)`,
          [
            definitionId,
            homeA,
            membershipA,
            new Date('2026-09-13T00:00:00.000Z'),
            OCCURRED,
          ],
        );
        await database.pool.query(
          `INSERT INTO task_instances (
             id, home_id, source, status, title, scheduled_for,
             task_definition_id, created_at, updated_at
           ) VALUES (
             $1, $2, 'RECURRING', 'OPEN', 'Instance snapshot title', DATE '2026-09-14',
             $3, $4, $4
           )`,
          [
            recurringId,
            homeA,
            definitionId,
            new Date('2026-09-12T17:00:00.000Z'),
          ],
        );
        await database.pool.query(
          `INSERT INTO task_instances (
             id, home_id, source, status, title, scheduled_for,
             completed_at, created_at, updated_at
           ) VALUES (
             $1, $2, 'MANUAL', 'COMPLETED', 'Finished', DATE '2026-09-10',
             $3, $3, $3
           )`,
          [completedId, homeA, new Date('2026-09-12T20:00:00.000Z')],
        );
        await database.pool.query(
          `INSERT INTO task_instances (
             id, home_id, source, status, title, scheduled_for,
             created_at, updated_at
           ) VALUES (
             $1, $2, 'MANUAL', 'OPEN', 'Earlier date', DATE '2026-09-13',
             $3, $3
           )`,
          [earlyDatedId, homeA, new Date('2026-09-12T19:00:00.000Z')],
        );
        const tieBreakEarlierId = '018f1e2c-7e3a-7000-8000-000000000001';
        const tieBreakLaterId = '018f1e2c-7e3a-7000-8000-000000000002';
        const tieCreated = new Date('2026-09-12T16:30:00.000Z');
        await database.pool.query(
          `INSERT INTO task_instances (
             id, home_id, source, status, title, scheduled_for,
             created_at, updated_at
           ) VALUES
             ($1, $3, 'MANUAL', 'OPEN', 'Tie later id', DATE '2026-09-12', $4, $4),
             ($2, $3, 'MANUAL', 'OPEN', 'Tie earlier id', DATE '2026-09-12', $4, $4)`,
          [tieBreakLaterId, tieBreakEarlierId, homeA, tieCreated],
        );

        const otherTask = await create({
          actor: roommate(homeB, otherMembership, userB),
          homeId: homeB,
          title: 'Other home secret',
        });

        const listed = await list({ actor: actorA, homeId: homeA });
        const titles = listed.map((row) => row.title);
        assert.equal(titles.includes('Other home secret'), false);
        assert.equal(
          listed.every((row) => row.homeId === homeA),
          true,
        );
        const openTitles = listed
          .filter((row) => row.status === 'OPEN')
          .map((row) => row.title);
        assert.deepEqual(openTitles.slice(0, 6), [
          'Tie earlier id',
          'Tie later id',
          'Earlier date',
          'Instance snapshot title',
          'Dated chore',
          'Assigned chore',
        ]);
        assert.equal(openTitles.at(-1), 'Undated chore');
        assert.equal(listed.at(-1)?.status, 'COMPLETED');
        assert.equal(listed.at(-1)?.title, 'Finished');

        const recurring = listed.find((row) => row.id === recurringId);
        assert.ok(recurring);
        assert.equal(recurring.title, 'Instance snapshot title');
        assert.equal(recurring.source, 'RECURRING');
        const dto = toTaskDto(recurring);
        assert.equal('taskDefinitionId' in dto, false);
        assert.equal(JSON.stringify(dto).includes('Definition title'), false);

        const otherListed = await list({
          actor: roommate(homeB, otherMembership, userB),
          homeId: homeB,
        });
        assert.deepEqual(
          otherListed.map((row) => row.id),
          [otherTask.id],
        );

        const emptyHome = createUuidV7();
        homeIds.push(emptyHome);
        await insertHome(database.pool, { id: emptyHome, name: 'Empty' });
        const emptyMembership = createUuidV7();
        await insertMembership(database.pool, {
          id: emptyMembership,
          homeId: emptyHome,
          userId: userA,
          role: 'ROOMMATE',
        });
        const empty = await list({
          actor: roommate(emptyHome, emptyMembership, userA),
          homeId: emptyHome,
        });
        assert.deepEqual(empty, []);

        const selfAssigned = await create({
          actor: actorA,
          homeId: homeA,
          title: 'Self assigned chore',
          assignedMembershipId: membershipA,
        });
        assert.equal(selfAssigned.assignedMembershipId, membershipA);

        const createdThenListed = await create({
          actor: actorA,
          homeId: homeA,
          title: 'Appears immediately',
        });
        const afterCreate = await list({ actor: actorA, homeId: homeA });
        assert.equal(
          afterCreate.some((row) => row.id === createdThenListed.id),
          true,
        );
      } finally {
        await cleanup(database.pool, { userIds, homeIds });
        await database.close();
      }
    },
  );

  void it(
    'does not persist a row when the create transaction rolls back',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userId = randomUUID();
      const homeId = createUuidV7();
      const membershipId = createUuidV7();

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, { id: homeId, name: 'Rollback' });
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ROOMMATE',
        });

        await assert.rejects(
          () =>
            runInReadCommittedTransaction(database.pool, async (tx) => {
              await tx.query(
                `INSERT INTO task_instances (
                   id, home_id, source, status, title, scheduled_for,
                   assigned_membership_id, task_definition_id, completed_at,
                   created_at, updated_at
                 ) VALUES (
                   $1::uuid, $2::uuid, 'MANUAL', 'OPEN', 'Will rollback',
                   NULL, NULL, NULL, NULL, $3::timestamptz, $3::timestamptz
                 )`,
                [createUuidV7(), homeId, OCCURRED],
              );
              throw new Error('force rollback');
            }),
          /force rollback/,
        );

        const leftover = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM task_instances
           WHERE home_id = $1 AND title = 'Will rollback'`,
          [homeId],
        );
        assert.equal(leftover.rows[0]?.count, '0');
      } finally {
        await cleanup(database.pool, {
          userIds: [userId],
          homeIds: [homeId],
        });
        await database.close();
      }
    },
  );
});
