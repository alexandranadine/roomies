import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createChangeMembershipRole } from '../home-administration/change-membership-role.js';
import { createEndMembershipWithinHomeStructureFromPool } from '../home-administration/end-membership-within-home-structure.js';
import { createLeaveMembership } from '../home-administration/leave-membership.js';
import { lockHomeAndExactMemberships } from '../../domains/homes/lock-home-and-exact-memberships.js';
import { lockHomeStructure } from '../../domains/homes/lock-home-structure.js';
import { createMembershipRoleWriter } from '../../domains/memberships/update-active-membership-role.js';
import { TaskDefinitionAlreadyDeactivatedError } from '../../domains/tasks/errors.js';
import { createTaskRepository } from '../../domains/tasks/repository.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  InvalidRequestError,
} from '../../platform/authz/errors.js';
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
import { createCreateRecurringTaskDefinition } from './create-recurring-task-definition.js';
import { createDeactivateTaskDefinition } from './deactivate-task-definition.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const STRESS_ITERATIONS = 10;

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

function createDefinitionCommand(
  pool: Pool,
  options: {
    afterLock?: () => Promise<void>;
    capturePid?: (pid: number) => void;
  } = {},
) {
  return createCreateRecurringTaskDefinition({
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
    ids: systemUuidV7,
  });
}

function deactivateCommand(
  pool: Pool,
  options: {
    afterLock?: () => Promise<void>;
    capturePid?: (pid: number) => void;
  } = {},
) {
  return createDeactivateTaskDefinition({
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
    endMembership: createEndMembershipWithinHomeStructureFromPool(pool),
  });
}

function changeRoleCommand(
  pool: Pool,
  options: {
    afterLock?: () => Promise<void>;
    capturePid?: (pid: number) => void;
  } = {},
) {
  return createChangeMembershipRole({
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
    outbox: outboxWriter,
    clock: systemClock,
    ids: systemUuidV7,
    roleWriter: createMembershipRoleWriter(),
  });
}

async function definitionState(
  pool: Pool,
  id: string,
): Promise<{
  assignedMembershipId: string | null;
  creatorMembershipId: string;
  deactivatedAt: Date | null;
  nextOccurrenceDate: string | null;
  nextOccurrenceAt: Date | null;
} | null> {
  const result = await pool.query<{
    assigned_membership_id: string | null;
    creator_membership_id: string;
    deactivated_at: Date | null;
    next_occurrence_date: string | null;
    next_occurrence_at: Date | null;
  }>(
    `SELECT assigned_membership_id, creator_membership_id, deactivated_at,
            next_occurrence_date::text AS next_occurrence_date,
            next_occurrence_at
     FROM task_definitions WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    assignedMembershipId: row.assigned_membership_id,
    creatorMembershipId: row.creator_membership_id,
    deactivatedAt: row.deactivated_at,
    nextOccurrenceDate: row.next_occurrence_date,
    nextOccurrenceAt: row.next_occurrence_at,
  };
}

void describe('recurring TaskDefinition concurrency PostgreSQL', () => {
  void it(
    'create vs assignee Membership end — both orders',
    { skip: skipWithoutDatabase, timeout: 120_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );

      try {
        for (let i = 0; i < STRESS_ITERATIONS; i += 1) {
          const adminId = randomUUID();
          const assigneeId = randomUUID();
          const homeId = createUuidV7();
          const adminMembership = createUuidV7();
          const assigneeMembership = createUuidV7();

          await insertUser(database.pool, adminId);
          await insertUser(database.pool, assigneeId);
          await insertHome(database.pool, homeId, `Create wins ${i}`);
          await insertMembership(database.pool, {
            id: adminMembership,
            homeId,
            userId: adminId,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: assigneeMembership,
            homeId,
            userId: assigneeId,
            role: 'ROOMMATE',
          });

          const createLocked = deferred();
          const createMayFinish = deferred();
          const leavePid = deferred<number>();
          const create = createDefinitionCommand(database.pool, {
            afterLock: async () => {
              createLocked.resolve();
              await createMayFinish.promise;
            },
          });
          const leave = leaveCommand(database.pool, {
            capturePid: (pid) => {
              leavePid.resolve(pid);
            },
          });

          const createRun = create({
            actor: actor({
              userId: adminId,
              membershipId: adminMembership,
              homeId,
              role: 'ADMIN',
            }),
            homeId,
            title: `Assigned ${i}`,
            frequency: 'DAILY',
            assignedMembershipId: assigneeMembership,
          });
          await createLocked.promise;
          const leaveRun = leave({
            actor: actor({
              userId: assigneeId,
              membershipId: assigneeMembership,
              homeId,
              role: 'ROOMMATE',
            }),
            homeId,
            membershipId: assigneeMembership,
          });
          await waitUntil(() =>
            leavePid.promise.then((pid) =>
              isWaitingForLock(database.pool, pid),
            ),
          );
          createMayFinish.resolve();
          const created = await createRun;
          await leaveRun;
          const state = await definitionState(database.pool, created.id);
          assert.ok(state);
          assert.equal(state.assignedMembershipId, null);
          assert.equal(state.creatorMembershipId, adminMembership);
          assert.equal(state.deactivatedAt, null);
          assert.notEqual(state.nextOccurrenceDate, null);
          assert.notEqual(state.nextOccurrenceAt, null);
          await cleanup(database.pool, {
            homeIds: [homeId],
            userIds: [adminId, assigneeId],
          });
        }

        for (let i = 0; i < STRESS_ITERATIONS; i += 1) {
          const adminId = randomUUID();
          const assigneeId = randomUUID();
          const homeId = createUuidV7();
          const adminMembership = createUuidV7();
          const assigneeMembership = createUuidV7();

          await insertUser(database.pool, adminId);
          await insertUser(database.pool, assigneeId);
          await insertHome(database.pool, homeId, `Leave wins ${i}`);
          await insertMembership(database.pool, {
            id: adminMembership,
            homeId,
            userId: adminId,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: assigneeMembership,
            homeId,
            userId: assigneeId,
            role: 'ROOMMATE',
          });

          const leaveLocked = deferred();
          const leaveMayFinish = deferred();
          const createPid = deferred<number>();
          const leave = leaveCommand(database.pool, {
            afterLock: async () => {
              leaveLocked.resolve();
              await leaveMayFinish.promise;
            },
          });
          const create = createDefinitionCommand(database.pool, {
            capturePid: (pid) => {
              createPid.resolve(pid);
            },
          });

          const leaveRun = leave({
            actor: actor({
              userId: assigneeId,
              membershipId: assigneeMembership,
              homeId,
              role: 'ROOMMATE',
            }),
            homeId,
            membershipId: assigneeMembership,
          });
          await leaveLocked.promise;
          const createRun = create({
            actor: actor({
              userId: adminId,
              membershipId: adminMembership,
              homeId,
              role: 'ADMIN',
            }),
            homeId,
            title: `Rejected ${i}`,
            frequency: 'DAILY',
            assignedMembershipId: assigneeMembership,
          });
          await waitUntil(() =>
            createPid.promise.then((pid) =>
              isWaitingForLock(database.pool, pid),
            ),
          );
          leaveMayFinish.resolve();
          await leaveRun;
          await assert.rejects(() => createRun, InvalidRequestError);
          const count = await database.pool.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM task_definitions WHERE home_id = $1`,
            [homeId],
          );
          assert.equal(count.rows[0]?.count, '0');
          await cleanup(database.pool, {
            homeIds: [homeId],
            userIds: [adminId, assigneeId],
          });
        }
      } finally {
        await database.close();
      }
    },
  );

  void it(
    'deactivate vs creator Membership end — both orders',
    { skip: skipWithoutDatabase, timeout: 120_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const seedCreate = createDefinitionCommand(database.pool);

      try {
        for (let i = 0; i < STRESS_ITERATIONS; i += 1) {
          const creatorId = randomUUID();
          const adminId = randomUUID();
          const homeId = createUuidV7();
          const creatorMembership = createUuidV7();
          const adminMembership = createUuidV7();

          await insertUser(database.pool, creatorId);
          await insertUser(database.pool, adminId);
          await insertHome(database.pool, homeId, `Deactivate wins ${i}`);
          await insertMembership(database.pool, {
            id: creatorMembership,
            homeId,
            userId: creatorId,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: adminMembership,
            homeId,
            userId: adminId,
            role: 'ADMIN',
          });
          const created = await seedCreate({
            actor: actor({
              userId: creatorId,
              membershipId: creatorMembership,
              homeId,
              role: 'ROOMMATE',
            }),
            homeId,
            title: `Creator ${i}`,
            frequency: 'DAILY',
          });

          const deactivateLocked = deferred();
          const deactivateMayFinish = deferred();
          const leavePid = deferred<number>();
          const deactivate = deactivateCommand(database.pool, {
            afterLock: async () => {
              deactivateLocked.resolve();
              await deactivateMayFinish.promise;
            },
          });
          const leave = leaveCommand(database.pool, {
            capturePid: (pid) => {
              leavePid.resolve(pid);
            },
          });

          const deactivateRun = deactivate({
            actor: actor({
              userId: creatorId,
              membershipId: creatorMembership,
              homeId,
              role: 'ROOMMATE',
            }),
            homeId,
            taskDefinitionId: created.id,
          });
          await deactivateLocked.promise;
          const leaveRun = leave({
            actor: actor({
              userId: creatorId,
              membershipId: creatorMembership,
              homeId,
              role: 'ROOMMATE',
            }),
            homeId,
            membershipId: creatorMembership,
          });
          await waitUntil(() =>
            leavePid.promise.then((pid) =>
              isWaitingForLock(database.pool, pid),
            ),
          );
          deactivateMayFinish.resolve();
          await deactivateRun;
          await leaveRun;
          const state = await definitionState(database.pool, created.id);
          assert.ok(state);
          assert.notEqual(state.deactivatedAt, null);
          assert.equal(state.nextOccurrenceDate, null);
          assert.equal(state.nextOccurrenceAt, null);
          await cleanup(database.pool, {
            homeIds: [homeId],
            userIds: [creatorId, adminId],
          });
        }

        for (let i = 0; i < STRESS_ITERATIONS; i += 1) {
          const creatorId = randomUUID();
          const adminId = randomUUID();
          const homeId = createUuidV7();
          const creatorMembership = createUuidV7();
          const adminMembership = createUuidV7();

          await insertUser(database.pool, creatorId);
          await insertUser(database.pool, adminId);
          await insertHome(database.pool, homeId, `Leave wins deactivate ${i}`);
          await insertMembership(database.pool, {
            id: creatorMembership,
            homeId,
            userId: creatorId,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: adminMembership,
            homeId,
            userId: adminId,
            role: 'ADMIN',
          });
          const created = await seedCreate({
            actor: actor({
              userId: creatorId,
              membershipId: creatorMembership,
              homeId,
              role: 'ROOMMATE',
            }),
            homeId,
            title: `Ended creator ${i}`,
            frequency: 'DAILY',
          });

          const leaveLocked = deferred();
          const leaveMayFinish = deferred();
          const deactivatePid = deferred<number>();
          const leave = leaveCommand(database.pool, {
            afterLock: async () => {
              leaveLocked.resolve();
              await leaveMayFinish.promise;
            },
          });
          const deactivate = deactivateCommand(database.pool, {
            capturePid: (pid) => {
              deactivatePid.resolve(pid);
            },
          });

          const leaveRun = leave({
            actor: actor({
              userId: creatorId,
              membershipId: creatorMembership,
              homeId,
              role: 'ROOMMATE',
            }),
            homeId,
            membershipId: creatorMembership,
          });
          await leaveLocked.promise;
          const deactivateRun = deactivate({
            actor: actor({
              userId: creatorId,
              membershipId: creatorMembership,
              homeId,
              role: 'ROOMMATE',
            }),
            homeId,
            taskDefinitionId: created.id,
          });
          await waitUntil(() =>
            deactivatePid.promise.then((pid) =>
              isWaitingForLock(database.pool, pid),
            ),
          );
          leaveMayFinish.resolve();
          await leaveRun;
          await assert.rejects(() => deactivateRun, ConcealedNotFoundError);
          const state = await definitionState(database.pool, created.id);
          assert.ok(state);
          assert.equal(state.deactivatedAt, null);
          assert.notEqual(state.nextOccurrenceDate, null);
          await cleanup(database.pool, {
            homeIds: [homeId],
            userIds: [creatorId, adminId],
          });
        }
      } finally {
        await database.close();
      }
    },
  );

  void it(
    'double deactivate — one winner and one already-deactivated conflict',
    { skip: skipWithoutDatabase, timeout: 120_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const seedCreate = createDefinitionCommand(database.pool);

      try {
        for (let i = 0; i < STRESS_ITERATIONS; i += 1) {
          const creatorId = randomUUID();
          const adminId = randomUUID();
          const homeId = createUuidV7();
          const creatorMembership = createUuidV7();
          const adminMembership = createUuidV7();

          await insertUser(database.pool, creatorId);
          await insertUser(database.pool, adminId);
          await insertHome(database.pool, homeId, `Double deactivate ${i}`);
          await insertMembership(database.pool, {
            id: creatorMembership,
            homeId,
            userId: creatorId,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: adminMembership,
            homeId,
            userId: adminId,
            role: 'ADMIN',
          });
          const created = await seedCreate({
            actor: actor({
              userId: creatorId,
              membershipId: creatorMembership,
              homeId,
              role: 'ROOMMATE',
            }),
            homeId,
            title: `Race ${i}`,
            frequency: 'DAILY',
          });

          const firstLocked = deferred();
          const firstMayFinish = deferred();
          const secondPid = deferred<number>();
          const first = deactivateCommand(database.pool, {
            afterLock: async () => {
              firstLocked.resolve();
              await firstMayFinish.promise;
            },
          });
          const second = deactivateCommand(database.pool, {
            capturePid: (pid) => {
              secondPid.resolve(pid);
            },
          });

          const firstRun = first({
            actor: actor({
              userId: creatorId,
              membershipId: creatorMembership,
              homeId,
              role: 'ROOMMATE',
            }),
            homeId,
            taskDefinitionId: created.id,
          });
          await firstLocked.promise;
          const secondRun = second({
            actor: actor({
              userId: adminId,
              membershipId: adminMembership,
              homeId,
              role: 'ADMIN',
            }),
            homeId,
            taskDefinitionId: created.id,
          });
          await waitUntil(() =>
            secondPid.promise.then((pid) =>
              isWaitingForLock(database.pool, pid),
            ),
          );
          firstMayFinish.resolve();
          const winner = await firstRun;
          await assert.rejects(
            () => secondRun,
            TaskDefinitionAlreadyDeactivatedError,
          );
          const state = await definitionState(database.pool, created.id);
          assert.ok(state);
          assert.equal(
            state.deactivatedAt?.toISOString(),
            winner.deactivatedAt?.toISOString(),
          );
          assert.equal(state.nextOccurrenceDate, null);
          assert.equal(state.nextOccurrenceAt, null);
          await cleanup(database.pool, {
            homeIds: [homeId],
            userIds: [creatorId, adminId],
          });
        }
      } finally {
        await database.close();
      }
    },
  );

  void it(
    'non-creator Admin deactivate vs ADMIN to ROOMMATE downgrade — both orders',
    { skip: skipWithoutDatabase, timeout: 120_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const seedCreate = createDefinitionCommand(database.pool);

      try {
        for (let i = 0; i < STRESS_ITERATIONS; i += 1) {
          const creatorId = randomUUID();
          const actingAdminId = randomUUID();
          const otherAdminId = randomUUID();
          const homeId = createUuidV7();
          const creatorMembership = createUuidV7();
          const actingAdminMembership = createUuidV7();
          const otherAdminMembership = createUuidV7();

          await insertUser(database.pool, creatorId);
          await insertUser(database.pool, actingAdminId);
          await insertUser(database.pool, otherAdminId);
          await insertHome(database.pool, homeId, `Admin deactivate wins ${i}`);
          await insertMembership(database.pool, {
            id: creatorMembership,
            homeId,
            userId: creatorId,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: actingAdminMembership,
            homeId,
            userId: actingAdminId,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: otherAdminMembership,
            homeId,
            userId: otherAdminId,
            role: 'ADMIN',
          });
          const created = await seedCreate({
            actor: actor({
              userId: creatorId,
              membershipId: creatorMembership,
              homeId,
              role: 'ROOMMATE',
            }),
            homeId,
            title: `Admin race ${i}`,
            frequency: 'DAILY',
          });

          const deactivateLocked = deferred();
          const deactivateMayFinish = deferred();
          const rolePid = deferred<number>();
          const deactivate = deactivateCommand(database.pool, {
            afterLock: async () => {
              deactivateLocked.resolve();
              await deactivateMayFinish.promise;
            },
          });
          const changeRole = changeRoleCommand(database.pool, {
            capturePid: (pid) => {
              rolePid.resolve(pid);
            },
          });

          const deactivateRun = deactivate({
            actor: actor({
              userId: actingAdminId,
              membershipId: actingAdminMembership,
              homeId,
              role: 'ADMIN',
            }),
            homeId,
            taskDefinitionId: created.id,
          });
          await deactivateLocked.promise;
          const roleRun = changeRole({
            actor: actor({
              userId: otherAdminId,
              membershipId: otherAdminMembership,
              homeId,
              role: 'ADMIN',
            }),
            homeId,
            membershipId: actingAdminMembership,
            role: 'ROOMMATE',
          });
          await waitUntil(() =>
            rolePid.promise.then((pid) => isWaitingForLock(database.pool, pid)),
          );
          deactivateMayFinish.resolve();
          await deactivateRun;
          await roleRun;
          const state = await definitionState(database.pool, created.id);
          assert.ok(state);
          assert.notEqual(state.deactivatedAt, null);
          await cleanup(database.pool, {
            homeIds: [homeId],
            userIds: [creatorId, actingAdminId, otherAdminId],
          });
        }

        for (let i = 0; i < STRESS_ITERATIONS; i += 1) {
          const creatorId = randomUUID();
          const actingAdminId = randomUUID();
          const otherAdminId = randomUUID();
          const homeId = createUuidV7();
          const creatorMembership = createUuidV7();
          const actingAdminMembership = createUuidV7();
          const otherAdminMembership = createUuidV7();

          await insertUser(database.pool, creatorId);
          await insertUser(database.pool, actingAdminId);
          await insertUser(database.pool, otherAdminId);
          await insertHome(database.pool, homeId, `Downgrade wins ${i}`);
          await insertMembership(database.pool, {
            id: creatorMembership,
            homeId,
            userId: creatorId,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: actingAdminMembership,
            homeId,
            userId: actingAdminId,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: otherAdminMembership,
            homeId,
            userId: otherAdminId,
            role: 'ADMIN',
          });
          const created = await seedCreate({
            actor: actor({
              userId: creatorId,
              membershipId: creatorMembership,
              homeId,
              role: 'ROOMMATE',
            }),
            homeId,
            title: `Downgrade ${i}`,
            frequency: 'DAILY',
          });

          const roleLocked = deferred();
          const roleMayFinish = deferred();
          const deactivatePid = deferred<number>();
          const changeRole = changeRoleCommand(database.pool, {
            afterLock: async () => {
              roleLocked.resolve();
              await roleMayFinish.promise;
            },
          });
          const deactivate = deactivateCommand(database.pool, {
            capturePid: (pid) => {
              deactivatePid.resolve(pid);
            },
          });

          const roleRun = changeRole({
            actor: actor({
              userId: otherAdminId,
              membershipId: otherAdminMembership,
              homeId,
              role: 'ADMIN',
            }),
            homeId,
            membershipId: actingAdminMembership,
            role: 'ROOMMATE',
          });
          await roleLocked.promise;
          const deactivateRun = deactivate({
            actor: actor({
              userId: actingAdminId,
              membershipId: actingAdminMembership,
              homeId,
              role: 'ADMIN',
            }),
            homeId,
            taskDefinitionId: created.id,
          });
          await waitUntil(() =>
            deactivatePid.promise.then((pid) =>
              isWaitingForLock(database.pool, pid),
            ),
          );
          roleMayFinish.resolve();
          await roleRun;
          await assert.rejects(() => deactivateRun, ConcealedNotFoundError);
          const state = await definitionState(database.pool, created.id);
          assert.ok(state);
          assert.equal(state.deactivatedAt, null);
          await cleanup(database.pool, {
            homeIds: [homeId],
            userIds: [creatorId, actingAdminId, otherAdminId],
          });
        }
      } finally {
        await database.close();
      }
    },
  );
});
