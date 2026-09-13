import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createArchiveFinalMemberHome } from '../home-administration/archive-final-member-home.js';
import {
  createApplyMembershipEndingWithinHomeStructureWithTemporaryNoOpCleanup,
  createEndMembershipWithinHomeStructureWithTemporaryNoOpCleanup,
} from '../home-administration/end-membership-within-home-structure.js';
import { createLeaveMembership } from '../home-administration/leave-membership.js';
import { createHomeArchiveWriter } from '../../domains/homes/archive-home.js';
import { lockHomeAndExactMemberships } from '../../domains/homes/lock-home-and-exact-memberships.js';
import { lockHomeStructure } from '../../domains/homes/lock-home-structure.js';
import { createInvitationHomeArchiveCleanupFromPool } from '../../domains/invitations/home-archive-cleanup.js';
import { TaskAlreadyCompletedError } from '../../domains/tasks/errors.js';
import { createTaskRepository } from '../../domains/tasks/repository.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import type { AppConfig } from '../../platform/config/types.js';
import { outboxWriter } from '../../platform/events/outbox-writer.js';
import { createUuidV7, systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import {
  runInReadCommittedTransaction,
  type TransactionContext,
} from '../../platform/persistence/transaction.js';
import { systemClock } from '../../platform/time/clock.js';
import { createCompleteTask } from './complete-task.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const STRESS_ITERATIONS = 10;
const CREATED = new Date('2026-09-12T17:00:00.000Z');

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

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 8_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 15);
    });
  }
  throw new Error('timed out waiting for lock wait');
}

async function isWaitingForLock(pool: Pool, pid: number): Promise<boolean> {
  const result = await pool.query<{ wait_event_type: string | null }>(
    'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
    [pid],
  );
  return result.rows[0]?.wait_event_type === 'Lock';
}

async function backendPid(tx: TransactionContext): Promise<number> {
  const result = await tx.query<{ pid: number | string }>(
    'SELECT pg_backend_pid() AS pid',
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('backend pid was missing');
  }
  return Number(row.pid);
}

function actor(input: {
  userId: string;
  membershipId: string;
  homeId: string;
  role: ActiveHomeActor['role'];
}): ActiveHomeActor {
  return { ...input };
}

async function insertUser(pool: Pool, id: string): Promise<void> {
  await pool.query('INSERT INTO users (id, updated_at) VALUES ($1, NOW())', [
    id,
  ]);
}

async function insertHome(pool: Pool, id: string, name: string): Promise<void> {
  await pool.query(
    `INSERT INTO homes (id, name, timezone, archived_at, updated_at)
     VALUES ($1, $2, 'UTC', NULL, NOW())`,
    [id, name],
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
    `INSERT INTO memberships (id, home_id, user_id, role, ended_at)
     VALUES ($1, $2, $3, $4, NULL)`,
    [input.id, input.homeId, input.userId, input.role],
  );
}

async function insertOpenManualTask(
  pool: Pool,
  input: { id: string; homeId: string; title: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO task_instances (
       id, home_id, source, status, title, scheduled_for,
       assigned_membership_id, task_definition_id, completed_at,
       created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, 'MANUAL', 'OPEN', $3, NULL, NULL, NULL, NULL,
       $4::timestamptz, $4::timestamptz
     )`,
    [input.id, input.homeId, input.title, CREATED],
  );
}

async function cleanup(
  pool: Pool,
  input: { homeIds: string[]; userIds: string[] },
): Promise<void> {
  if (input.homeIds.length > 0) {
    await pool.query('DELETE FROM task_instances WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query('DELETE FROM invitations WHERE home_id = ANY($1)', [
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

function completeCommand(
  pool: Pool,
  options: {
    afterLock?: () => Promise<void>;
    capturePid?: (pid: number) => void;
  } = {},
) {
  return createCompleteTask({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeAndExactMemberships: async (tx, input) => {
      if (options.capturePid) {
        options.capturePid(await backendPid(tx));
      }
      const locked = await lockHomeAndExactMemberships(tx, input);
      if (options.afterLock) {
        await options.afterLock();
      }
      return locked;
    },
    tasks: createTaskRepository(pool),
    clock: systemClock,
  });
}

function archiveCommand(
  pool: Pool,
  options: {
    afterLock?: () => Promise<void>;
    capturePid?: (pid: number) => void;
  } = {},
) {
  return createArchiveFinalMemberHome({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeStructure: async (tx, input) => {
      if (options.capturePid) {
        options.capturePid(await backendPid(tx));
      }
      const locked = await lockHomeStructure(tx, input);
      if (options.afterLock) {
        await options.afterLock();
      }
      return locked;
    },
    clock: systemClock,
    invitationRevoker: createInvitationHomeArchiveCleanupFromPool(pool),
    applyMembershipEnding:
      createApplyMembershipEndingWithinHomeStructureWithTemporaryNoOpCleanup(),
    homeArchive: createHomeArchiveWriter(),
    outbox: outboxWriter,
    ids: systemUuidV7,
  });
}

function leaveCommand(
  pool: Pool,
  options: {
    afterLock?: () => Promise<void>;
    capturePid?: (pid: number) => void;
  } = {},
) {
  return createLeaveMembership({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeStructure: async (tx, input) => {
      if (options.capturePid) {
        options.capturePid(await backendPid(tx));
      }
      const locked = await lockHomeStructure(tx, input);
      if (options.afterLock) {
        await options.afterLock();
      }
      return locked;
    },
    clock: systemClock,
    endMembership:
      createEndMembershipWithinHomeStructureWithTemporaryNoOpCleanup(),
  });
}

async function taskStatus(
  pool: Pool,
  taskId: string,
): Promise<{ status: string; completedAt: Date | null }> {
  const result = await pool.query<{
    status: string;
    completed_at: Date | null;
  }>('SELECT status, completed_at FROM task_instances WHERE id = $1', [taskId]);
  return {
    status: result.rows[0]?.status ?? 'missing',
    completedAt: result.rows[0]?.completed_at ?? null,
  };
}

async function homeArchivedAt(
  pool: Pool,
  homeId: string,
): Promise<Date | null> {
  const result = await pool.query<{ archived_at: Date | null }>(
    'SELECT archived_at FROM homes WHERE id = $1',
    [homeId],
  );
  return result.rows[0]?.archived_at ?? null;
}

async function membershipEndedAt(
  pool: Pool,
  membershipId: string,
): Promise<Date | null> {
  const result = await pool.query<{ ended_at: Date | null }>(
    'SELECT ended_at FROM memberships WHERE id = $1',
    [membershipId],
  );
  return result.rows[0]?.ended_at ?? null;
}

function observe<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  );
}

void describe('Task completion concurrency PostgreSQL', () => {
  void it(
    'double completion of the same Task has exactly one winner',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const membershipB = randomUUID();
      const taskId = createUuidV7();
      const firstLocked = deferred();
      const firstMayFinish = deferred();
      const secondPid = deferred<number>();
      let secondFinished = false;
      const roommateA = actor({
        userId: userA,
        membershipId: membershipA,
        homeId,
        role: 'ROOMMATE',
      });
      const roommateB = actor({
        userId: userB,
        membershipId: membershipB,
        homeId,
        role: 'ROOMMATE',
      });

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, homeId, 'Double complete');
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
          id: taskId,
          homeId,
          title: 'One completion',
        });

        const first = completeCommand(database.pool, {
          afterLock: async () => {
            firstLocked.resolve();
            await firstMayFinish.promise;
          },
        });
        const second = completeCommand(database.pool, {
          capturePid: (pid) => {
            secondPid.resolve(pid);
          },
        });

        const firstRun = first({
          actor: roommateA,
          homeId,
          taskId,
        });
        await firstLocked.promise;

        const secondRun = observe(
          second({
            actor: roommateB,
            homeId,
            taskId,
          }).finally(() => {
            secondFinished = true;
          }),
        );
        const pid = await secondPid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));
        assert.equal(secondFinished, false);
        assert.equal((await taskStatus(database.pool, taskId)).status, 'OPEN');

        firstMayFinish.resolve();
        const winner = await firstRun;
        assert.equal(winner.status, 'COMPLETED');
        const loser = await secondRun;
        assert.equal(loser.status, 'rejected');
        assert.ok(loser.reason instanceof TaskAlreadyCompletedError);
        const final = await taskStatus(database.pool, taskId);
        assert.equal(final.status, 'COMPLETED');
        assert.ok(final.completedAt);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userA, userB],
        });
        await database.close();
      }
    },
  );

  void it(
    'repeated double-completion stays one winner and deadlock-free',
    { skip: skipWithoutDatabase, timeout: 120_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const homeIds: string[] = [];
      const userIds: string[] = [];

      try {
        for (let iteration = 0; iteration < STRESS_ITERATIONS; iteration += 1) {
          const userA = randomUUID();
          const userB = randomUUID();
          const homeId = randomUUID();
          const membershipA = randomUUID();
          const membershipB = randomUUID();
          const taskId = createUuidV7();
          userIds.push(userA, userB);
          homeIds.push(homeId);
          await insertUser(database.pool, userA);
          await insertUser(database.pool, userB);
          await insertHome(database.pool, homeId, `Stress ${iteration}`);
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
            id: taskId,
            homeId,
            title: `Stress ${iteration}`,
          });

          const settled = await Promise.allSettled([
            completeCommand(database.pool)({
              actor: actor({
                userId: userA,
                membershipId: membershipA,
                homeId,
                role: 'ROOMMATE',
              }),
              homeId,
              taskId,
            }),
            completeCommand(database.pool)({
              actor: actor({
                userId: userB,
                membershipId: membershipB,
                homeId,
                role: 'ROOMMATE',
              }),
              homeId,
              taskId,
            }),
          ]);
          const wins = settled.filter(
            (result) => result.status === 'fulfilled',
          );
          const losses = settled.filter(
            (result) => result.status === 'rejected',
          );
          assert.equal(wins.length, 1);
          assert.equal(losses.length, 1);
          assert.ok(losses[0] !== undefined && losses[0].status === 'rejected');
          assert.ok(losses[0].reason instanceof TaskAlreadyCompletedError);
          const final = await taskStatus(database.pool, taskId);
          assert.equal(final.status, 'COMPLETED');
          assert.ok(final.completedAt);
        }
      } finally {
        await cleanup(database.pool, { homeIds, userIds });
        await database.close();
      }
    },
  );

  void it(
    'complete winning the Home-archive race commits while the Home is active',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userId = randomUUID();
      const homeId = randomUUID();
      const membershipId = randomUUID();
      const taskId = createUuidV7();
      const completeLocked = deferred();
      const completeMayFinish = deferred();
      const archivePid = deferred<number>();
      let archiveFinished = false;
      const admin = actor({
        userId,
        membershipId,
        homeId,
        role: 'ADMIN',
      });

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, homeId, 'Archive race A');
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ADMIN',
        });
        await insertOpenManualTask(database.pool, {
          id: taskId,
          homeId,
          title: 'Complete wins archive',
        });

        const complete = completeCommand(database.pool, {
          afterLock: async () => {
            completeLocked.resolve();
            await completeMayFinish.promise;
          },
        });
        const archive = archiveCommand(database.pool, {
          capturePid: (pid) => {
            archivePid.resolve(pid);
          },
        });

        const completeRun = complete({
          actor: admin,
          homeId,
          taskId,
        });
        await completeLocked.promise;

        const archiveRun = archive({ homeId, actor: admin }).then(() => {
          archiveFinished = true;
        });
        const pid = await archivePid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));
        assert.equal(archiveFinished, false);
        assert.equal(await homeArchivedAt(database.pool, homeId), null);

        completeMayFinish.resolve();
        const completed = await completeRun;
        assert.equal(completed.status, 'COMPLETED');
        assert.equal(await homeArchivedAt(database.pool, homeId), null);
        await archiveRun;
        assert.equal(archiveFinished, true);
        assert.ok(await homeArchivedAt(database.pool, homeId));
        assert.equal(
          (await taskStatus(database.pool, taskId)).status,
          'COMPLETED',
        );
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userId],
        });
        await database.close();
      }
    },
  );

  void it(
    'archive winning the race conceals complete and leaves the Task OPEN',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userId = randomUUID();
      const homeId = randomUUID();
      const membershipId = randomUUID();
      const taskId = createUuidV7();
      const archiveLocked = deferred();
      const archiveMayFinish = deferred();
      const completePid = deferred<number>();
      let completeFinished = false;
      const admin = actor({
        userId,
        membershipId,
        homeId,
        role: 'ADMIN',
      });

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, homeId, 'Archive race B');
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ADMIN',
        });
        await insertOpenManualTask(database.pool, {
          id: taskId,
          homeId,
          title: 'Archive wins complete',
        });

        const archive = archiveCommand(database.pool, {
          afterLock: async () => {
            archiveLocked.resolve();
            await archiveMayFinish.promise;
          },
        });
        const complete = completeCommand(database.pool, {
          capturePid: (pid) => {
            completePid.resolve(pid);
          },
        });

        const archiveRun = archive({ homeId, actor: admin });
        await archiveLocked.promise;

        const completeRun = observe(
          complete({
            actor: admin,
            homeId,
            taskId,
          }).finally(() => {
            completeFinished = true;
          }),
        );
        const pid = await completePid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));
        assert.equal(completeFinished, false);

        archiveMayFinish.resolve();
        await archiveRun;
        assert.ok(await homeArchivedAt(database.pool, homeId));
        const completed = await completeRun;
        assert.equal(completed.status, 'rejected');
        assert.ok(completed.reason instanceof ConcealedNotFoundError);
        assert.equal((await taskStatus(database.pool, taskId)).status, 'OPEN');
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userId],
        });
        await database.close();
      }
    },
  );

  void it(
    'complete winning the actor-end race commits while the actor is active',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const adminId = randomUUID();
      const actorId = randomUUID();
      const homeId = randomUUID();
      const adminMembershipId = randomUUID();
      const actorMembershipId = randomUUID();
      const taskId = createUuidV7();
      const completeLocked = deferred();
      const completeMayFinish = deferred();
      const leavePid = deferred<number>();
      let leaveFinished = false;
      const roommate = actor({
        userId: actorId,
        membershipId: actorMembershipId,
        homeId,
        role: 'ROOMMATE',
      });

      try {
        await insertUser(database.pool, adminId);
        await insertUser(database.pool, actorId);
        await insertHome(database.pool, homeId, 'Actor-end race A');
        await insertMembership(database.pool, {
          id: adminMembershipId,
          homeId,
          userId: adminId,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: actorMembershipId,
          homeId,
          userId: actorId,
          role: 'ROOMMATE',
        });
        await insertOpenManualTask(database.pool, {
          id: taskId,
          homeId,
          title: 'Complete wins actor-end',
        });

        const complete = completeCommand(database.pool, {
          afterLock: async () => {
            completeLocked.resolve();
            await completeMayFinish.promise;
          },
        });
        const leave = leaveCommand(database.pool, {
          capturePid: (pid) => {
            leavePid.resolve(pid);
          },
        });

        const completeRun = complete({
          actor: roommate,
          homeId,
          taskId,
        });
        await completeLocked.promise;

        const leaveRun = leave({
          actor: roommate,
          homeId,
          membershipId: actorMembershipId,
        }).then(() => {
          leaveFinished = true;
        });
        const pid = await leavePid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));
        assert.equal(leaveFinished, false);
        assert.equal(
          await membershipEndedAt(database.pool, actorMembershipId),
          null,
        );

        completeMayFinish.resolve();
        const completed = await completeRun;
        assert.equal(completed.status, 'COMPLETED');
        assert.equal(
          await membershipEndedAt(database.pool, actorMembershipId),
          null,
        );
        await leaveRun;
        assert.ok(await membershipEndedAt(database.pool, actorMembershipId));
        assert.equal(
          (await taskStatus(database.pool, taskId)).status,
          'COMPLETED',
        );
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [adminId, actorId],
        });
        await database.close();
      }
    },
  );

  void it(
    'actor-end winning the race conceals complete and leaves the Task OPEN',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const adminId = randomUUID();
      const actorId = randomUUID();
      const homeId = randomUUID();
      const adminMembershipId = randomUUID();
      const actorMembershipId = randomUUID();
      const taskId = createUuidV7();
      const leaveLocked = deferred();
      const leaveMayFinish = deferred();
      const completePid = deferred<number>();
      const roommate = actor({
        userId: actorId,
        membershipId: actorMembershipId,
        homeId,
        role: 'ROOMMATE',
      });

      try {
        await insertUser(database.pool, adminId);
        await insertUser(database.pool, actorId);
        await insertHome(database.pool, homeId, 'Actor-end race B');
        await insertMembership(database.pool, {
          id: adminMembershipId,
          homeId,
          userId: adminId,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: actorMembershipId,
          homeId,
          userId: actorId,
          role: 'ROOMMATE',
        });
        await insertOpenManualTask(database.pool, {
          id: taskId,
          homeId,
          title: 'Actor-end wins complete',
        });

        const leave = leaveCommand(database.pool, {
          afterLock: async () => {
            leaveLocked.resolve();
            await leaveMayFinish.promise;
          },
        });
        const complete = completeCommand(database.pool, {
          capturePid: (pid) => {
            completePid.resolve(pid);
          },
        });

        const leaveRun = leave({
          actor: roommate,
          homeId,
          membershipId: actorMembershipId,
        });
        await leaveLocked.promise;

        const completeRun = observe(
          complete({
            actor: roommate,
            homeId,
            taskId,
          }),
        );
        const pid = await completePid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));

        leaveMayFinish.resolve();
        await leaveRun;
        assert.ok(await membershipEndedAt(database.pool, actorMembershipId));
        const completed = await completeRun;
        assert.equal(completed.status, 'rejected');
        assert.ok(completed.reason instanceof ConcealedNotFoundError);
        assert.equal((await taskStatus(database.pool, taskId)).status, 'OPEN');
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [adminId, actorId],
        });
        await database.close();
      }
    },
  );
});
