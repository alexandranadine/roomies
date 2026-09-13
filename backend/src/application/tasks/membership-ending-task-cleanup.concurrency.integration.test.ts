import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createHomeArchiveWriter } from '../../domains/homes/archive-home.js';
import {
  createApplyMembershipEndingWithinHomeStructureFromPool,
  createEndMembershipWithinHomeStructureFromPool,
} from '../home-administration/end-membership-within-home-structure.js';
import { createArchiveFinalMemberHome } from '../home-administration/archive-final-member-home.js';
import { createLeaveMembership } from '../home-administration/leave-membership.js';
import { lockHomeAndExactMemberships } from '../../domains/homes/lock-home-and-exact-memberships.js';
import { lockHomeStructure } from '../../domains/homes/lock-home-structure.js';
import { createTaskRepository } from '../../domains/tasks/repository.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { InvalidRequestError } from '../../platform/authz/errors.js';
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
import type { Clock } from '../../platform/time/clock.js';
import { systemClock } from '../../platform/time/clock.js';
import { createCompleteTask } from './complete-task.js';
import { createCreateManualTask } from './create-manual-task.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const STRESS_ITERATIONS = 10;
const CREATED = new Date('2026-09-12T17:00:00.000Z');
const TASK_CREATED_AT = new Date('2026-09-12T17:15:00.000Z');
const COMPLETE_AT = new Date('2026-09-12T17:30:00.000Z');
const ENDING_AT = new Date('2026-09-12T18:00:00.000Z');
const LATER_COMPLETE_AT = new Date('2026-09-12T19:00:00.000Z');
const ARCHIVE_AT = new Date('2026-09-12T18:30:00.000Z');

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

async function insertAssignedOpenTask(
  pool: Pool,
  input: { id: string; homeId: string; title: string; membershipId: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO task_instances (
       id, home_id, source, status, title, scheduled_for,
       assigned_membership_id, task_definition_id, completed_at,
       created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, 'MANUAL', 'OPEN', $3, NULL, $4::uuid, NULL, NULL,
       $5::timestamptz, $5::timestamptz
     )`,
    [input.id, input.homeId, input.title, input.membershipId, CREATED],
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
    await pool.query('DELETE FROM task_definitions WHERE home_id = ANY($1)', [
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
    clock?: Clock;
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
    clock: options.clock ?? systemClock,
  });
}

function createTaskCommand(
  pool: Pool,
  options: {
    afterLock?: () => Promise<void>;
    capturePid?: (pid: number) => void;
    clock?: Clock;
  } = {},
) {
  return createCreateManualTask({
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
    clock: options.clock ?? systemClock,
    ids: systemUuidV7,
  });
}

function leaveCommand(
  pool: Pool,
  options: {
    afterLock?: () => Promise<void>;
    capturePid?: (pid: number) => void;
    clock?: Clock;
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
    clock: options.clock ?? systemClock,
    endMembership: createEndMembershipWithinHomeStructureFromPool(pool),
  });
}

function archiveCommand(
  pool: Pool,
  options: {
    beforeLock?: () => Promise<void>;
    clock?: Clock;
  } = {},
) {
  return createArchiveFinalMemberHome({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeStructure: async (tx, input) => {
      if (options.beforeLock) {
        await options.beforeLock();
      }
      return lockHomeStructure(tx, input);
    },
    clock: options.clock ?? systemClock,
    invitationRevoker: {
      lockPendingForHomeArchive() {
        return Promise.resolve();
      },
      revokeLockedPendingForHomeArchive() {
        return Promise.resolve();
      },
    },
    applyMembershipEnding:
      createApplyMembershipEndingWithinHomeStructureFromPool(pool),
    homeArchive: createHomeArchiveWriter(),
    outbox: outboxWriter,
    ids: systemUuidV7,
  });
}

async function insertDefinition(
  pool: Pool,
  input: {
    id: string;
    homeId: string;
    title: string;
    assignedMembershipId: string;
    creatorMembershipId: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO task_definitions (
       id, home_id, title, assigned_membership_id, creator_membership_id,
       recurrence_frequency, recurrence_weekday, recurrence_day_of_month,
       next_occurrence_at, deactivated_at, created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, 'DAILY', NULL, NULL,
       $6::timestamptz, NULL, $6::timestamptz, $6::timestamptz
     )`,
    [
      input.id,
      input.homeId,
      input.title,
      input.assignedMembershipId,
      input.creatorMembershipId,
      CREATED,
    ],
  );
}

async function taskState(
  pool: Pool,
  taskId: string,
): Promise<{
  status: string;
  assignedMembershipId: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  completedAt: Date | null;
}> {
  const result = await pool.query<{
    status: string;
    assigned_membership_id: string | null;
    created_at: Date;
    updated_at: Date;
    completed_at: Date | null;
  }>(
    `SELECT status, assigned_membership_id, created_at, updated_at, completed_at
     FROM task_instances WHERE id = $1`,
    [taskId],
  );
  return {
    status: result.rows[0]?.status ?? 'missing',
    assignedMembershipId: result.rows[0]?.assigned_membership_id ?? null,
    createdAt: result.rows[0]?.created_at ?? null,
    updatedAt: result.rows[0]?.updated_at ?? null,
    completedAt: result.rows[0]?.completed_at ?? null,
  };
}

async function definitionState(
  pool: Pool,
  definitionId: string,
): Promise<{
  assignedMembershipId: string | null;
  updatedAt: Date | null;
}> {
  const result = await pool.query<{
    assigned_membership_id: string | null;
    updated_at: Date;
  }>(
    `SELECT assigned_membership_id, updated_at FROM task_definitions WHERE id = $1`,
    [definitionId],
  );
  return {
    assignedMembershipId: result.rows[0]?.assigned_membership_id ?? null,
    updatedAt: result.rows[0]?.updated_at ?? null,
  };
}

async function endedEventOccurredAt(
  pool: Pool,
  homeId: string,
): Promise<Date | null> {
  const result = await pool.query<{ occurred_at: Date }>(
    `SELECT occurred_at FROM outbox_events
     WHERE home_id = $1 AND event_type = 'membership.ended.v1'`,
    [homeId],
  );
  return result.rows[0]?.occurred_at ?? null;
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

void describe('Membership-ending Task cleanup concurrency PostgreSQL', () => {
  void it(
    'complete winning before cleanup preserves historical assignment',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const adminId = randomUUID();
      const leavingId = randomUUID();
      const homeId = randomUUID();
      const adminMembership = randomUUID();
      const leavingMembership = randomUUID();
      const taskId = createUuidV7();
      const completeLocked = deferred();
      const completeMayFinish = deferred();
      const leavePid = deferred<number>();
      let leaveFinished = false;

      try {
        await insertUser(database.pool, adminId);
        await insertUser(database.pool, leavingId);
        await insertHome(database.pool, homeId, 'Complete wins cleanup');
        await insertMembership(database.pool, {
          id: adminMembership,
          homeId,
          userId: adminId,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: leavingMembership,
          homeId,
          userId: leavingId,
          role: 'ROOMMATE',
        });
        await insertAssignedOpenTask(database.pool, {
          id: taskId,
          homeId,
          title: 'Assigned to leaving member',
          membershipId: leavingMembership,
        });

        const complete = completeCommand(database.pool, {
          afterLock: async () => {
            completeLocked.resolve();
            await completeMayFinish.promise;
          },
          clock: { now: () => COMPLETE_AT },
        });
        let leaveClockCalls = 0;
        const leave = leaveCommand(database.pool, {
          capturePid: (pid) => {
            leavePid.resolve(pid);
          },
          clock: {
            now() {
              leaveClockCalls += 1;
              return ENDING_AT;
            },
          },
        });

        const completeRun = complete({
          actor: actor({
            userId: adminId,
            membershipId: adminMembership,
            homeId,
            role: 'ADMIN',
          }),
          homeId,
          taskId,
        });
        await completeLocked.promise;
        const leaveRun = leave({
          actor: actor({
            userId: leavingId,
            membershipId: leavingMembership,
            homeId,
            role: 'ROOMMATE',
          }),
          homeId,
          membershipId: leavingMembership,
        }).then(() => {
          leaveFinished = true;
        });
        const pid = await leavePid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));
        assert.equal(leaveFinished, false);
        assert.equal(leaveClockCalls, 0);

        completeMayFinish.resolve();
        await completeRun;
        await leaveRun;

        const state = await taskState(database.pool, taskId);
        const endedAt = await membershipEndedAt(
          database.pool,
          leavingMembership,
        );
        assert.equal(state.status, 'COMPLETED');
        assert.equal(state.assignedMembershipId, leavingMembership);
        assert.deepEqual(state.completedAt, COMPLETE_AT);
        assert.deepEqual(endedAt, ENDING_AT);
        assert.equal(COMPLETE_AT <= ENDING_AT, true);
        assert.deepEqual(
          await endedEventOccurredAt(database.pool, homeId),
          ENDING_AT,
        );
        assert.equal(leaveClockCalls, 1);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [adminId, leavingId],
        });
        await database.close();
      }
    },
  );

  void it(
    'cleanup winning first leaves a later completion unassigned',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const adminId = randomUUID();
      const leavingId = randomUUID();
      const homeId = randomUUID();
      const adminMembership = randomUUID();
      const leavingMembership = randomUUID();
      const taskId = createUuidV7();
      const leaveLocked = deferred();
      const leaveMayFinish = deferred();
      const completePid = deferred<number>();
      let completeFinished = false;

      try {
        await insertUser(database.pool, adminId);
        await insertUser(database.pool, leavingId);
        await insertHome(database.pool, homeId, 'Cleanup wins complete');
        await insertMembership(database.pool, {
          id: adminMembership,
          homeId,
          userId: adminId,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: leavingMembership,
          homeId,
          userId: leavingId,
          role: 'ROOMMATE',
        });
        await insertAssignedOpenTask(database.pool, {
          id: taskId,
          homeId,
          title: 'Cleanup first',
          membershipId: leavingMembership,
        });

        let leaveClockCalls = 0;
        let cleanupUpdatedAt: Date | null = null;
        let cleanupAssigned: string | null | undefined;
        const leave = leaveCommand(database.pool, {
          afterLock: async () => {
            leaveLocked.resolve();
            await leaveMayFinish.promise;
          },
          clock: {
            now() {
              leaveClockCalls += 1;
              return ENDING_AT;
            },
          },
        });
        const complete = completeCommand(database.pool, {
          capturePid: (pid) => {
            completePid.resolve(pid);
          },
          afterLock: async () => {
            const mid = await taskState(database.pool, taskId);
            cleanupUpdatedAt = mid.updatedAt;
            cleanupAssigned = mid.assignedMembershipId;
          },
          clock: { now: () => LATER_COMPLETE_AT },
        });

        const leaveRun = leave({
          actor: actor({
            userId: leavingId,
            membershipId: leavingMembership,
            homeId,
            role: 'ROOMMATE',
          }),
          homeId,
          membershipId: leavingMembership,
        });
        await leaveLocked.promise;
        const completeObserved = observe(
          complete({
            actor: actor({
              userId: adminId,
              membershipId: adminMembership,
              homeId,
              role: 'ADMIN',
            }),
            homeId,
            taskId,
          }).then((value) => {
            completeFinished = true;
            return value;
          }),
        );
        const pid = await completePid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));
        assert.equal(completeFinished, false);

        leaveMayFinish.resolve();
        await leaveRun;
        const completed = await completeObserved;
        assert.equal(completed.status, 'fulfilled');

        const state = await taskState(database.pool, taskId);
        const endedAt = await membershipEndedAt(
          database.pool,
          leavingMembership,
        );
        assert.equal(state.status, 'COMPLETED');
        assert.equal(state.assignedMembershipId, null);
        assert.deepEqual(cleanupUpdatedAt, ENDING_AT);
        assert.equal(cleanupAssigned, null);
        assert.deepEqual(endedAt, ENDING_AT);
        assert.deepEqual(state.completedAt, LATER_COMPLETE_AT);
        assert.equal(ENDING_AT < LATER_COMPLETE_AT, true);
        assert.deepEqual(
          await endedEventOccurredAt(database.pool, homeId),
          ENDING_AT,
        );
        assert.equal(leaveClockCalls, 1);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [adminId, leavingId],
        });
        await database.close();
      }
    },
  );

  void it(
    'create winning before ending is later unassigned by cleanup',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const adminId = randomUUID();
      const leavingId = randomUUID();
      const homeId = randomUUID();
      const adminMembership = randomUUID();
      const leavingMembership = randomUUID();
      const createLocked = deferred();
      const createMayFinish = deferred();
      const leavePid = deferred<number>();
      const definitionId = createUuidV7();

      try {
        await insertUser(database.pool, adminId);
        await insertUser(database.pool, leavingId);
        await insertHome(database.pool, homeId, 'Create wins ending');
        await insertMembership(database.pool, {
          id: adminMembership,
          homeId,
          userId: adminId,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: leavingMembership,
          homeId,
          userId: leavingId,
          role: 'ROOMMATE',
        });
        await insertDefinition(database.pool, {
          id: definitionId,
          homeId,
          title: 'Assigned definition',
          assignedMembershipId: leavingMembership,
          creatorMembershipId: adminMembership,
        });

        const create = createTaskCommand(database.pool, {
          afterLock: async () => {
            createLocked.resolve();
            await createMayFinish.promise;
          },
          clock: { now: () => TASK_CREATED_AT },
        });
        let leaveClockCalls = 0;
        const leave = leaveCommand(database.pool, {
          capturePid: (pid) => {
            leavePid.resolve(pid);
          },
          clock: {
            now() {
              leaveClockCalls += 1;
              return ENDING_AT;
            },
          },
        });

        const created = create({
          actor: actor({
            userId: adminId,
            membershipId: adminMembership,
            homeId,
            role: 'ADMIN',
          }),
          homeId,
          title: 'Assigned then ended',
          assignedMembershipId: leavingMembership,
        });
        await createLocked.promise;
        const leaveRun = leave({
          actor: actor({
            userId: leavingId,
            membershipId: leavingMembership,
            homeId,
            role: 'ROOMMATE',
          }),
          homeId,
          membershipId: leavingMembership,
        });
        const pid = await leavePid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));
        assert.equal(leaveClockCalls, 0);

        createMayFinish.resolve();
        const task = await created;
        await leaveRun;

        const state = await taskState(database.pool, task.id);
        const endedAt = await membershipEndedAt(
          database.pool,
          leavingMembership,
        );
        const definition = await definitionState(database.pool, definitionId);
        assert.equal(state.status, 'OPEN');
        assert.equal(state.assignedMembershipId, null);
        assert.deepEqual(state.createdAt, TASK_CREATED_AT);
        assert.deepEqual(state.updatedAt, ENDING_AT);
        assert.equal(TASK_CREATED_AT <= ENDING_AT, true);
        assert.ok(state.createdAt);
        assert.ok(state.updatedAt);
        assert.equal(state.createdAt <= state.updatedAt, true);
        assert.deepEqual(endedAt, ENDING_AT);
        assert.deepEqual(state.updatedAt, endedAt);
        assert.equal(definition.assignedMembershipId, null);
        assert.deepEqual(definition.updatedAt, ENDING_AT);
        assert.deepEqual(
          await endedEventOccurredAt(database.pool, homeId),
          ENDING_AT,
        );
        assert.equal(leaveClockCalls, 1);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [adminId, leavingId],
        });
        await database.close();
      }
    },
  );

  void it(
    'create winning before archive waits produces one later archive timestamp',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const adminId = randomUUID();
      const homeId = randomUUID();
      const adminMembership = randomUUID();
      const definitionId = createUuidV7();
      const archiveReachedLock = deferred();
      const archiveMayLock = deferred();
      let archiveClockCalls = 0;

      try {
        await insertUser(database.pool, adminId);
        await insertHome(database.pool, homeId, 'Create wins archive waits');
        await insertMembership(database.pool, {
          id: adminMembership,
          homeId,
          userId: adminId,
          role: 'ADMIN',
        });
        await insertDefinition(database.pool, {
          id: definitionId,
          homeId,
          title: 'Final-member definition',
          assignedMembershipId: adminMembership,
          creatorMembershipId: adminMembership,
        });

        const archiveRun = archiveCommand(database.pool, {
          beforeLock: async () => {
            archiveReachedLock.resolve();
            await archiveMayLock.promise;
          },
          clock: {
            now() {
              archiveClockCalls += 1;
              return ARCHIVE_AT;
            },
          },
        })({
          homeId,
          actor: actor({
            userId: adminId,
            membershipId: adminMembership,
            homeId,
            role: 'ADMIN',
          }),
        });

        await archiveReachedLock.promise;
        assert.equal(archiveClockCalls, 0);

        const task = await createTaskCommand(database.pool, {
          clock: { now: () => TASK_CREATED_AT },
        })({
          actor: actor({
            userId: adminId,
            membershipId: adminMembership,
            homeId,
            role: 'ADMIN',
          }),
          homeId,
          title: 'Created before archive lock',
          assignedMembershipId: adminMembership,
        });
        assert.equal(archiveClockCalls, 0);

        archiveMayLock.resolve();
        await archiveRun;

        const state = await taskState(database.pool, task.id);
        const definition = await definitionState(database.pool, definitionId);
        const endedAt = await membershipEndedAt(database.pool, adminMembership);
        const archivedAt = await homeArchivedAt(database.pool, homeId);
        assert.equal(state.status, 'OPEN');
        assert.equal(state.assignedMembershipId, null);
        assert.deepEqual(state.createdAt, TASK_CREATED_AT);
        assert.deepEqual(state.updatedAt, ARCHIVE_AT);
        assert.equal(ARCHIVE_AT >= TASK_CREATED_AT, true);
        assert.deepEqual(endedAt, ARCHIVE_AT);
        assert.deepEqual(archivedAt, ARCHIVE_AT);
        assert.deepEqual(state.updatedAt, endedAt);
        assert.deepEqual(endedAt, archivedAt);
        assert.equal(definition.assignedMembershipId, null);
        assert.deepEqual(definition.updatedAt, ARCHIVE_AT);
        assert.deepEqual(
          await endedEventOccurredAt(database.pool, homeId),
          ARCHIVE_AT,
        );
        assert.equal(archiveClockCalls, 1);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [adminId],
        });
        await database.close();
      }
    },
  );

  void it(
    'ending winning first rejects a later assigned create for that tenure',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const adminId = randomUUID();
      const leavingId = randomUUID();
      const homeId = randomUUID();
      const adminMembership = randomUUID();
      const leavingMembership = randomUUID();
      const leaveLocked = deferred();
      const leaveMayFinish = deferred();
      const createPid = deferred<number>();

      try {
        await insertUser(database.pool, adminId);
        await insertUser(database.pool, leavingId);
        await insertHome(database.pool, homeId, 'Ending wins create');
        await insertMembership(database.pool, {
          id: adminMembership,
          homeId,
          userId: adminId,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: leavingMembership,
          homeId,
          userId: leavingId,
          role: 'ROOMMATE',
        });

        const leave = leaveCommand(database.pool, {
          afterLock: async () => {
            leaveLocked.resolve();
            await leaveMayFinish.promise;
          },
        });
        const create = createTaskCommand(database.pool, {
          capturePid: (pid) => {
            createPid.resolve(pid);
          },
        });

        const leaveRun = leave({
          actor: actor({
            userId: leavingId,
            membershipId: leavingMembership,
            homeId,
            role: 'ROOMMATE',
          }),
          homeId,
          membershipId: leavingMembership,
        });
        await leaveLocked.promise;
        const created = observe(
          create({
            actor: actor({
              userId: adminId,
              membershipId: adminMembership,
              homeId,
              role: 'ADMIN',
            }),
            homeId,
            title: 'Should reject ended assignee',
            assignedMembershipId: leavingMembership,
          }),
        );
        const pid = await createPid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));

        leaveMayFinish.resolve();
        await leaveRun;
        const result = await created;
        assert.equal(result.status, 'rejected');
        assert.ok(result.reason instanceof InvalidRequestError);
        assert.ok(await membershipEndedAt(database.pool, leavingMembership));

        const assignedAfterEnd = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM task_instances
           WHERE home_id = $1
             AND assigned_membership_id = $2
             AND status = 'OPEN'`,
          [homeId, leavingMembership],
        );
        assert.equal(assignedAfterEnd.rows[0]?.count, '0');
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [adminId, leavingId],
        });
        await database.close();
      }
    },
  );

  void it(
    'two Membership endings in the same Home do not deadlock or cross-clean',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const adminId = randomUUID();
      const firstId = randomUUID();
      const secondId = randomUUID();
      const homeId = randomUUID();
      const adminMembership = randomUUID();
      const firstMembership = randomUUID();
      const secondMembership = randomUUID();
      const firstTask = createUuidV7();
      const secondTask = createUuidV7();

      try {
        await insertUser(database.pool, adminId);
        await insertUser(database.pool, firstId);
        await insertUser(database.pool, secondId);
        await insertHome(database.pool, homeId, 'Two endings');
        await insertMembership(database.pool, {
          id: adminMembership,
          homeId,
          userId: adminId,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: firstMembership,
          homeId,
          userId: firstId,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: secondMembership,
          homeId,
          userId: secondId,
          role: 'ROOMMATE',
        });
        await insertAssignedOpenTask(database.pool, {
          id: firstTask,
          homeId,
          title: 'First tenure',
          membershipId: firstMembership,
        });
        await insertAssignedOpenTask(database.pool, {
          id: secondTask,
          homeId,
          title: 'Second tenure',
          membershipId: secondMembership,
        });

        const firstLeave = leaveCommand(database.pool);
        const secondLeave = leaveCommand(database.pool);
        const settled = await Promise.allSettled([
          firstLeave({
            actor: actor({
              userId: firstId,
              membershipId: firstMembership,
              homeId,
              role: 'ROOMMATE',
            }),
            homeId,
            membershipId: firstMembership,
          }),
          secondLeave({
            actor: actor({
              userId: secondId,
              membershipId: secondMembership,
              homeId,
              role: 'ROOMMATE',
            }),
            homeId,
            membershipId: secondMembership,
          }),
        ]);
        assert.equal(
          settled.filter((result) => result.status === 'fulfilled').length,
          2,
        );

        assert.equal(
          (await taskState(database.pool, firstTask)).assignedMembershipId,
          null,
        );
        assert.equal(
          (await taskState(database.pool, secondTask)).assignedMembershipId,
          null,
        );
        assert.ok(await membershipEndedAt(database.pool, firstMembership));
        assert.ok(await membershipEndedAt(database.pool, secondMembership));
        assert.equal(
          await membershipEndedAt(database.pool, adminMembership),
          null,
        );
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [adminId, firstId, secondId],
        });
        await database.close();
      }
    },
  );

  void it(
    `stresses lock-order races for ${STRESS_ITERATIONS} iterations without deadlock or forbidden finals`,
    { skip: skipWithoutDatabase, timeout: 180_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const homeIds: string[] = [];
      const userIds: string[] = [];

      try {
        for (let iteration = 0; iteration < STRESS_ITERATIONS; iteration += 1) {
          const adminId = randomUUID();
          const leavingId = randomUUID();
          const otherId = randomUUID();
          const homeId = randomUUID();
          const adminMembership = randomUUID();
          const leavingMembership = randomUUID();
          const otherMembership = randomUUID();
          const completeTaskId = createUuidV7();
          const otherTaskId = createUuidV7();
          homeIds.push(homeId);
          userIds.push(adminId, leavingId, otherId);

          await insertUser(database.pool, adminId);
          await insertUser(database.pool, leavingId);
          await insertUser(database.pool, otherId);
          await insertHome(
            database.pool,
            homeId,
            `Cleanup stress ${iteration}`,
          );
          await insertMembership(database.pool, {
            id: adminMembership,
            homeId,
            userId: adminId,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: leavingMembership,
            homeId,
            userId: leavingId,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: otherMembership,
            homeId,
            userId: otherId,
            role: 'ROOMMATE',
          });
          await insertAssignedOpenTask(database.pool, {
            id: completeTaskId,
            homeId,
            title: `Stress complete ${iteration}`,
            membershipId: leavingMembership,
          });
          await insertAssignedOpenTask(database.pool, {
            id: otherTaskId,
            homeId,
            title: `Stress other ${iteration}`,
            membershipId: otherMembership,
          });

          const completeFirst = iteration % 2 === 0;
          if (completeFirst) {
            const completeLocked = deferred();
            const completeMayFinish = deferred();
            const leavePid = deferred<number>();
            const completeRun = completeCommand(database.pool, {
              afterLock: async () => {
                completeLocked.resolve();
                await completeMayFinish.promise;
              },
            })({
              actor: actor({
                userId: adminId,
                membershipId: adminMembership,
                homeId,
                role: 'ADMIN',
              }),
              homeId,
              taskId: completeTaskId,
            });
            await completeLocked.promise;
            const leaveRun = leaveCommand(database.pool, {
              capturePid: (pid) => {
                leavePid.resolve(pid);
              },
            })({
              actor: actor({
                userId: leavingId,
                membershipId: leavingMembership,
                homeId,
                role: 'ROOMMATE',
              }),
              homeId,
              membershipId: leavingMembership,
            });
            await waitUntil(() =>
              leavePid.promise.then((pid) =>
                isWaitingForLock(database.pool, pid),
              ),
            );
            completeMayFinish.resolve();
            await completeRun;
            await leaveRun;
            const completed = await taskState(database.pool, completeTaskId);
            assert.equal(completed.status, 'COMPLETED');
            assert.equal(completed.assignedMembershipId, leavingMembership);
          } else {
            const leaveLocked = deferred();
            const leaveMayFinish = deferred();
            const createPid = deferred<number>();
            const leaveRun = leaveCommand(database.pool, {
              afterLock: async () => {
                leaveLocked.resolve();
                await leaveMayFinish.promise;
              },
            })({
              actor: actor({
                userId: leavingId,
                membershipId: leavingMembership,
                homeId,
                role: 'ROOMMATE',
              }),
              homeId,
              membershipId: leavingMembership,
            });
            await leaveLocked.promise;
            const created = observe(
              createTaskCommand(database.pool, {
                capturePid: (pid) => {
                  createPid.resolve(pid);
                },
              })({
                actor: actor({
                  userId: adminId,
                  membershipId: adminMembership,
                  homeId,
                  role: 'ADMIN',
                }),
                homeId,
                title: `Stress create ${iteration}`,
                assignedMembershipId: leavingMembership,
              }),
            );
            await waitUntil(() =>
              createPid.promise.then((pid) =>
                isWaitingForLock(database.pool, pid),
              ),
            );
            leaveMayFinish.resolve();
            await leaveRun;
            const result = await created;
            assert.equal(result.status, 'rejected');
            assert.ok(result.reason instanceof InvalidRequestError);
          }

          const twoLeave = await Promise.allSettled([
            leaveCommand(database.pool)({
              actor: actor({
                userId: otherId,
                membershipId: otherMembership,
                homeId,
                role: 'ROOMMATE',
              }),
              homeId,
              membershipId: otherMembership,
            }),
            Promise.resolve(),
          ]);
          assert.equal(twoLeave[0]?.status, 'fulfilled');
          assert.equal(
            (await taskState(database.pool, otherTaskId)).assignedMembershipId,
            null,
          );
          const forbidden = await database.pool.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM task_instances
             WHERE home_id = $1
               AND status = 'OPEN'
               AND assigned_membership_id = $2`,
            [homeId, leavingMembership],
          );
          assert.equal(forbidden.rows[0]?.count, '0');
        }
      } finally {
        await cleanup(database.pool, { homeIds, userIds });
        await database.close();
      }
    },
  );
});
