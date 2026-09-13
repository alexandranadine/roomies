import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { lockHomeAndExactMemberships } from '../../domains/homes/lock-home-and-exact-memberships.js';
import { TaskAlreadyCompletedError } from '../../domains/tasks/errors.js';
import { createTaskRepository } from '../../domains/tasks/repository.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import type { AppConfig } from '../../platform/config/types.js';
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
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
const CREATED = new Date('2026-09-12T17:00:00.000Z');
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

async function insertOpenManualTask(
  pool: Pool,
  input: {
    id: string;
    homeId: string;
    title: string;
    scheduledFor?: string | null;
    assignedMembershipId?: string | null;
    createdAt?: Date;
  },
): Promise<void> {
  const createdAt = input.createdAt ?? CREATED;
  await pool.query(
    `INSERT INTO task_instances (
       id, home_id, source, status, title, scheduled_for,
       assigned_membership_id, task_definition_id, completed_at,
       created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, 'MANUAL', 'OPEN', $3, $4::date, $5::uuid,
       NULL, NULL, $6::timestamptz, $6::timestamptz
     )`,
    [
      input.id,
      input.homeId,
      input.title,
      input.scheduledFor ?? null,
      input.assignedMembershipId ?? null,
      createdAt,
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

function completeCommand(pool: Pool) {
  return createCompleteTask({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeAndExactMemberships,
    tasks: createTaskRepository(pool),
    clock: {
      now() {
        return OCCURRED;
      },
    },
  });
}

void describe('Task completion PostgreSQL', () => {
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
    'completes an OPEN Task once and conceals unauthorized cases',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const complete = completeCommand(database.pool);
      const create = createCreateManualTaskFromPool(database.pool);

      const userA = randomUUID();
      const userB = randomUUID();
      const homeA = createUuidV7();
      const homeB = createUuidV7();
      const archivedHome = createUuidV7();
      const membershipA = createUuidV7();
      const membershipB = createUuidV7();
      const endedMembership = createUuidV7();
      const oldTenure = createUuidV7();
      const otherMembership = createUuidV7();
      const archivedMembership = createUuidV7();
      const endedAssignee = createUuidV7();
      const userIds = [userA, userB];
      const homeIds = [homeA, homeB, archivedHome];

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeA, name: 'Home A' });
        await insertHome(database.pool, { id: homeB, name: 'Home B' });
        await insertHome(database.pool, {
          id: archivedHome,
          name: 'Archived',
          archived: true,
        });
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
          id: oldTenure,
          homeId: homeA,
          userId: userA,
          role: 'ROOMMATE',
          ended: true,
        });
        await insertMembership(database.pool, {
          id: endedAssignee,
          homeId: homeA,
          userId: userB,
          role: 'ROOMMATE',
          ended: true,
        });
        await insertMembership(database.pool, {
          id: otherMembership,
          homeId: homeB,
          userId: userB,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: archivedMembership,
          homeId: archivedHome,
          userId: userA,
          role: 'ROOMMATE',
        });

        const actorA = actor({
          userId: userA,
          membershipId: membershipA,
          homeId: homeA,
          role: 'ROOMMATE',
        });
        const actorAdmin = actor({
          userId: userB,
          membershipId: membershipB,
          homeId: homeA,
          role: 'ADMIN',
        });

        const datedId = createUuidV7();
        const assignedEndedId = createUuidV7();
        const adminTaskId = createUuidV7();
        const alreadyId = createUuidV7();
        const otherHomeTaskId = createUuidV7();
        const archivedTaskId = createUuidV7();
        await insertOpenManualTask(database.pool, {
          id: datedId,
          homeId: homeA,
          title: 'Dated chore',
          scheduledFor: '2026-09-15',
          assignedMembershipId: membershipA,
        });
        await insertOpenManualTask(database.pool, {
          id: assignedEndedId,
          homeId: homeA,
          title: 'Assigned to ended tenure',
          scheduledFor: null,
          assignedMembershipId: endedAssignee,
        });
        await insertOpenManualTask(database.pool, {
          id: adminTaskId,
          homeId: homeA,
          title: 'Admin completes',
        });
        await insertOpenManualTask(database.pool, {
          id: alreadyId,
          homeId: homeA,
          title: 'Already done later',
        });
        await insertOpenManualTask(database.pool, {
          id: otherHomeTaskId,
          homeId: homeB,
          title: 'Other home secret',
        });
        await insertOpenManualTask(database.pool, {
          id: archivedTaskId,
          homeId: archivedHome,
          title: 'Archived home task',
        });

        const completed = await complete({
          actor: actorA,
          homeId: homeA,
          taskId: datedId,
        });
        assert.equal(completed.id, datedId);
        assert.equal(completed.status, 'COMPLETED');
        assert.equal(completed.source, 'MANUAL');
        assert.equal(completed.title, 'Dated chore');
        assert.equal(completed.scheduledFor, '2026-09-15');
        assert.equal(completed.assignedMembershipId, membershipA);
        assert.equal(completed.completedAt?.getTime(), OCCURRED.getTime());
        assert.equal(completed.updatedAt.getTime(), OCCURRED.getTime());
        assert.equal(completed.createdAt.getTime(), CREATED.getTime());

        const datedRow = await database.pool.query<{
          status: string;
          source: string;
          title: string;
          scheduled_for: string | null;
          assigned_membership_id: string | null;
          task_definition_id: string | null;
          completed_at: Date | null;
          updated_at: Date;
        }>(
          `SELECT status, source, title, scheduled_for::text AS scheduled_for,
                  assigned_membership_id, task_definition_id, completed_at,
                  updated_at
           FROM task_instances WHERE id = $1 AND home_id = $2`,
          [datedId, homeA],
        );
        assert.equal(datedRow.rows[0]?.status, 'COMPLETED');
        assert.equal(datedRow.rows[0]?.source, 'MANUAL');
        assert.equal(datedRow.rows[0]?.title, 'Dated chore');
        assert.equal(datedRow.rows[0]?.scheduled_for, '2026-09-15');
        assert.equal(datedRow.rows[0]?.assigned_membership_id, membershipA);
        assert.equal(datedRow.rows[0]?.task_definition_id, null);
        assert.equal(
          datedRow.rows[0]?.completed_at?.getTime(),
          OCCURRED.getTime(),
        );
        assert.equal(
          datedRow.rows[0]?.updated_at.getTime(),
          OCCURRED.getTime(),
        );
        const scheduledFor = datedRow.rows[0]?.scheduled_for;
        assert.equal(typeof scheduledFor, 'string');
        assert.notEqual(
          Object.prototype.toString.call(scheduledFor),
          '[object Date]',
        );

        const checkSatisfied = await database.pool.query<{ ok: boolean }>(
          `SELECT (
             status = 'COMPLETED'
             AND completed_at IS NOT NULL
             AND completed_at >= created_at
           ) AS ok
           FROM task_instances WHERE id = $1`,
          [datedId],
        );
        assert.equal(checkSatisfied.rows[0]?.ok, true);

        const assignedEnded = await complete({
          actor: actorA,
          homeId: homeA,
          taskId: assignedEndedId,
        });
        assert.equal(assignedEnded.status, 'COMPLETED');
        assert.equal(assignedEnded.assignedMembershipId, endedAssignee);

        const adminCompleted = await complete({
          actor: actorAdmin,
          homeId: homeA,
          taskId: adminTaskId,
        });
        assert.equal(adminCompleted.status, 'COMPLETED');

        await complete({
          actor: actorA,
          homeId: homeA,
          taskId: alreadyId,
        });
        await assert.rejects(
          () =>
            complete({
              actor: actorAdmin,
              homeId: homeA,
              taskId: alreadyId,
            }),
          TaskAlreadyCompletedError,
        );
        const secondAttempt = await database.pool.query<{
          completed_at: Date;
          updated_at: Date;
        }>(
          'SELECT completed_at, updated_at FROM task_instances WHERE id = $1',
          [alreadyId],
        );
        assert.equal(
          secondAttempt.rows[0]?.completed_at.getTime(),
          OCCURRED.getTime(),
        );
        assert.equal(
          secondAttempt.rows[0]?.updated_at.getTime(),
          OCCURRED.getTime(),
        );

        await assert.rejects(
          () =>
            complete({
              actor: actorA,
              homeId: homeA,
              taskId: createUuidV7(),
            }),
          ConcealedNotFoundError,
        );
        await assert.rejects(
          () =>
            complete({
              actor: actorA,
              homeId: homeA,
              taskId: otherHomeTaskId,
            }),
          ConcealedNotFoundError,
        );
        const otherStillOpen = await database.pool.query<{ status: string }>(
          'SELECT status FROM task_instances WHERE id = $1',
          [otherHomeTaskId],
        );
        assert.equal(otherStillOpen.rows[0]?.status, 'OPEN');

        await assert.rejects(
          () =>
            complete({
              actor: actor({
                userId: userA,
                membershipId: archivedMembership,
                homeId: archivedHome,
                role: 'ROOMMATE',
              }),
              homeId: archivedHome,
              taskId: archivedTaskId,
            }),
          ConcealedNotFoundError,
        );
        const archivedStillOpen = await database.pool.query<{ status: string }>(
          'SELECT status FROM task_instances WHERE id = $1',
          [archivedTaskId],
        );
        assert.equal(archivedStillOpen.rows[0]?.status, 'OPEN');

        await assert.rejects(
          () =>
            complete({
              actor: actor({
                userId: userA,
                membershipId: endedMembership,
                homeId: homeA,
                role: 'ROOMMATE',
              }),
              homeId: homeA,
              taskId: datedId,
            }),
          ConcealedNotFoundError,
        );
        await assert.rejects(
          () =>
            complete({
              actor: actor({
                userId: userA,
                membershipId: oldTenure,
                homeId: homeA,
                role: 'ROOMMATE',
              }),
              homeId: homeA,
              taskId: datedId,
            }),
          ConcealedNotFoundError,
        );

        const definitionId = createUuidV7();
        const recurringId = createUuidV7();
        const nextOccurrenceAt = new Date('2026-09-16T00:00:00.000Z');
        await database.pool.query(
          `INSERT INTO task_definitions (
             id, home_id, title, creator_membership_id, recurrence_frequency,
             next_occurrence_at, created_at, updated_at
           ) VALUES ($1, $2, 'Definition stays put', $3, 'DAILY', $4, $5, $5)`,
          [definitionId, homeA, membershipA, nextOccurrenceAt, CREATED],
        );
        await database.pool.query(
          `INSERT INTO task_instances (
             id, home_id, source, status, title, scheduled_for,
             assigned_membership_id, task_definition_id, completed_at,
             created_at, updated_at
           ) VALUES (
             $1, $2, 'RECURRING', 'OPEN', 'Instance snapshot title',
             DATE '2026-09-14', $3, $4, NULL, $5, $5
           )`,
          [recurringId, homeA, membershipA, definitionId, CREATED],
        );
        const definitionBefore = await database.pool.query<{
          title: string;
          next_occurrence_at: Date | null;
          deactivated_at: Date | null;
          updated_at: Date;
        }>(
          `SELECT title, next_occurrence_at, deactivated_at, updated_at
           FROM task_definitions WHERE id = $1`,
          [definitionId],
        );
        const recurringCompleted = await complete({
          actor: actorA,
          homeId: homeA,
          taskId: recurringId,
        });
        assert.equal(recurringCompleted.status, 'COMPLETED');
        assert.equal(recurringCompleted.source, 'RECURRING');
        assert.equal(recurringCompleted.title, 'Instance snapshot title');
        assert.equal(recurringCompleted.scheduledFor, '2026-09-14');
        const definitionAfter = await database.pool.query<{
          title: string;
          next_occurrence_at: Date | null;
          deactivated_at: Date | null;
          updated_at: Date;
        }>(
          `SELECT title, next_occurrence_at, deactivated_at, updated_at
           FROM task_definitions WHERE id = $1`,
          [definitionId],
        );
        assert.deepEqual(definitionAfter.rows[0], definitionBefore.rows[0]);
        const instanceCount = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM task_instances
           WHERE task_definition_id = $1`,
          [definitionId],
        );
        assert.equal(instanceCount.rows[0]?.count, '1');
        const recurringRow = await database.pool.query<{
          task_definition_id: string;
          status: string;
        }>(
          'SELECT task_definition_id, status FROM task_instances WHERE id = $1',
          [recurringId],
        );
        assert.equal(recurringRow.rows[0]?.task_definition_id, definitionId);
        assert.equal(recurringRow.rows[0]?.status, 'COMPLETED');

        const outbox = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM outbox_events
           WHERE home_id = ANY($1::uuid[])`,
          [[homeA, homeB, archivedHome]],
        );
        assert.equal(outbox.rows[0]?.count, '0');

        const createdThenCompleted = await create({
          actor: actorA,
          homeId: homeA,
          title: 'Created then completed',
        });
        const liveComplete = createCompleteTaskFromPool(database.pool);
        const live = await liveComplete({
          actor: actorA,
          homeId: homeA,
          taskId: createdThenCompleted.id,
        });
        assert.equal(live.status, 'COMPLETED');
        assert.ok(live.completedAt);
        assert.ok(live.completedAt.getTime() >= live.createdAt.getTime());
      } finally {
        await cleanup(database.pool, { userIds, homeIds });
        await database.close();
      }
    },
  );

  void it(
    'rolls back a failed completion and leaves the Task OPEN',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userId = randomUUID();
      const homeId = createUuidV7();
      const membershipId = createUuidV7();
      const taskId = createUuidV7();
      const tasks = createTaskRepository(database.pool);

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, { id: homeId, name: 'Rollback' });
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ROOMMATE',
        });
        await insertOpenManualTask(database.pool, {
          id: taskId,
          homeId,
          title: 'Will rollback',
        });

        await assert.rejects(
          () =>
            runInReadCommittedTransaction(database.pool, async (tx) => {
              const completed = await tasks.completeOpenTask(tx, {
                homeId,
                taskId,
                completedAt: OCCURRED,
                updatedAt: OCCURRED,
              });
              assert.equal(completed?.status, 'COMPLETED');
              throw new Error('force rollback');
            }),
          /force rollback/,
        );

        const leftover = await database.pool.query<{
          status: string;
          completed_at: Date | null;
        }>('SELECT status, completed_at FROM task_instances WHERE id = $1', [
          taskId,
        ]);
        assert.equal(leftover.rows[0]?.status, 'OPEN');
        assert.equal(leftover.rows[0]?.completed_at, null);

        const complete = completeCommand(database.pool);
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
                  await tasks.completeOpenTask(tx, input);
                  throw new Error('application rollback');
                },
              },
              clock: {
                now() {
                  return OCCURRED;
                },
              },
            })({
              actor: actor({
                userId,
                membershipId,
                homeId,
                role: 'ROOMMATE',
              }),
              homeId,
              taskId,
            }),
          /application rollback/,
        );

        const afterApp = await database.pool.query<{
          status: string;
          completed_at: Date | null;
        }>('SELECT status, completed_at FROM task_instances WHERE id = $1', [
          taskId,
        ]);
        assert.equal(afterApp.rows[0]?.status, 'OPEN');
        assert.equal(afterApp.rows[0]?.completed_at, null);

        const recovered = await complete({
          actor: actor({
            userId,
            membershipId,
            homeId,
            role: 'ROOMMATE',
          }),
          homeId,
          taskId,
        });
        assert.equal(recovered.status, 'COMPLETED');
      } finally {
        await cleanup(database.pool, {
          userIds: [userId],
          homeIds: [homeId],
        });
        await database.close();
      }
    },
  );

  void it(
    'completes distinct Tasks in the same Home concurrently',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const homeId = createUuidV7();
      const membershipA = createUuidV7();
      const membershipB = createUuidV7();
      const taskA = createUuidV7();
      const taskB = createUuidV7();
      const complete = completeCommand(database.pool);

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeId, name: 'Concurrent' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId,
          userId: userB,
          role: 'ROOMMATE',
        });
        await insertOpenManualTask(database.pool, {
          id: taskA,
          homeId,
          title: 'Task A',
        });
        await insertOpenManualTask(database.pool, {
          id: taskB,
          homeId,
          title: 'Task B',
        });

        const [first, second] = await Promise.all([
          complete({
            actor: actor({
              userId: userA,
              membershipId: membershipA,
              homeId,
              role: 'ROOMMATE',
            }),
            homeId,
            taskId: taskA,
          }),
          complete({
            actor: actor({
              userId: userB,
              membershipId: membershipB,
              homeId,
              role: 'ROOMMATE',
            }),
            homeId,
            taskId: taskB,
          }),
        ]);
        assert.equal(first.status, 'COMPLETED');
        assert.equal(second.status, 'COMPLETED');
        assert.equal(first.id, taskA);
        assert.equal(second.id, taskB);
      } finally {
        await cleanup(database.pool, {
          userIds: [userA, userB],
          homeIds: [homeId],
        });
        await database.close();
      }
    },
  );
});
