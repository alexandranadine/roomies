import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createArchiveFinalMemberHome } from '../home-administration/archive-final-member-home.js';
import {
  createApplyMembershipEndingWithinHomeStructureFromPool,
  createEndMembershipWithinHomeStructureFromPool,
} from '../home-administration/end-membership-within-home-structure.js';
import { createLeaveMembership } from '../home-administration/leave-membership.js';
import { createHomeArchiveWriter } from '../../domains/homes/archive-home.js';
import { lockHomeAndExactMemberships } from '../../domains/homes/lock-home-and-exact-memberships.js';
import { lockHomeStructure } from '../../domains/homes/lock-home-structure.js';
import { createInvitationHomeArchiveCleanupFromPool } from '../../domains/invitations/home-archive-cleanup.js';
import { MaintenanceNotOpenError } from '../../domains/maintenance/errors.js';
import { createMaintenanceRepository } from '../../domains/maintenance/repository.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import type { AppConfig } from '../../platform/config/types.js';
import { outboxWriter } from '../../platform/events/outbox-writer.js';
import { systemUuidV7 } from '../../platform/ids/uuid-v7.js';
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
import { createResolveMaintenanceEntry } from './resolve-maintenance-entry.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const CREATED = new Date('2026-09-13T12:00:00.000Z');

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
    await pool.query(
      'DELETE FROM maintenance_audiences WHERE home_id = ANY($1)',
      [input.homeIds],
    );
    await pool.query(
      'DELETE FROM maintenance_entries WHERE home_id = ANY($1)',
      [input.homeIds],
    );
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

async function insertOpenHousehold(
  pool: Pool,
  input: {
    id: string;
    homeId: string;
    createdByMembershipId: string;
    title: string;
  },
): Promise<void> {
  const repository = createMaintenanceRepository(pool);
  await runInReadCommittedTransaction(pool, async (tx) => {
    await repository.insertEntryWithAudience(tx, {
      entry: {
        id: input.id,
        homeId: input.homeId,
        createdByMembershipId: input.createdByMembershipId,
        visibility: 'HOUSEHOLD',
        title: input.title,
        details: null,
        status: 'OPEN',
        resolvedByMembershipId: null,
        resolvedAt: null,
        createdAt: CREATED,
        updatedAt: CREATED,
      },
      audienceMembershipIds: [],
    });
  });
}

async function entryState(
  pool: Pool,
  id: string,
): Promise<{
  status: string;
  resolved_by_membership_id: string | null;
  resolved_at: Date | null;
  home_id: string;
}> {
  const result = await pool.query<{
    status: string;
    resolved_by_membership_id: string | null;
    resolved_at: Date | null;
    home_id: string;
  }>(
    `SELECT status, resolved_by_membership_id, resolved_at, home_id
     FROM maintenance_entries WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('maintenance entry was missing');
  }
  return row;
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

type LockHooks = {
  afterLock?: () => Promise<void>;
  capturePid?: (pid: number) => void;
};

function wrapHomeLock(options: LockHooks) {
  return async (
    tx: TransactionContext,
    input: {
      homeId: string;
      membershipIds: readonly string[];
    },
  ) => {
    if (options.capturePid) {
      options.capturePid(await backendPid(tx));
    }
    const locked = await lockHomeAndExactMemberships(tx, input);
    if (options.afterLock) {
      await options.afterLock();
    }
    return locked;
  };
}

function resolveCommand(pool: Pool, options: LockHooks = {}) {
  return createResolveMaintenanceEntry({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeAndExactMemberships: wrapHomeLock(options),
    maintenance: createMaintenanceRepository(pool),
    clock: systemClock,
  });
}

function leaveCommand(pool: Pool, options: LockHooks = {}) {
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

function archiveCommand(pool: Pool, options: LockHooks = {}) {
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
      createApplyMembershipEndingWithinHomeStructureFromPool(pool),
    homeArchive: createHomeArchiveWriter(),
    outbox: outboxWriter,
    ids: systemUuidV7,
  });
}

void describe('Maintenance resolve concurrency PostgreSQL', () => {
  void it(
    'lets exactly one of two visible actors resolve the same OPEN entry',
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
      const entryId = randomUUID();
      const firstLocked = deferred();
      const firstMayFinish = deferred();
      const secondPid = deferred<number>();
      const actorA = actor({
        userId: userA,
        membershipId: membershipA,
        homeId,
        role: 'ROOMMATE',
      });
      const actorB = actor({
        userId: userB,
        membershipId: membershipB,
        homeId,
        role: 'ADMIN',
      });

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, homeId, 'Resolve vs resolve');
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
          role: 'ADMIN',
        });
        await insertOpenHousehold(database.pool, {
          id: entryId,
          homeId,
          createdByMembershipId: membershipA,
          title: 'Race',
        });

        const first = resolveCommand(database.pool, {
          afterLock: async () => {
            firstLocked.resolve();
            await firstMayFinish.promise;
          },
        });
        const second = resolveCommand(database.pool, {
          capturePid: (pid) => {
            secondPid.resolve(pid);
          },
        });

        const firstRun = first({
          actor: actorA,
          homeId,
          maintenanceEntryId: entryId,
        });
        await firstLocked.promise;
        const secondRun = observe(
          second({
            actor: actorB,
            homeId,
            maintenanceEntryId: entryId,
          }),
        );
        const pid = await secondPid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));

        firstMayFinish.resolve();
        const winner = await firstRun;
        const loser = await secondRun;
        assert.equal(winner.status, 'RESOLVED');
        assert.equal(winner.resolvedByMembershipId, membershipA);
        assert.equal(loser.status, 'rejected');
        assert.ok(loser.reason instanceof MaintenanceNotOpenError);
        const row = await entryState(database.pool, entryId);
        assert.equal(row.status, 'RESOLVED');
        assert.equal(row.resolved_by_membership_id, membershipA);
        assert.notEqual(row.resolved_by_membership_id, membershipB);
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
    'resolve winning the actor-end race keeps the ended Membership as resolver',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userAdmin = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const adminId = randomUUID();
      const entryId = randomUUID();
      const resolveLocked = deferred();
      const resolveMayFinish = deferred();
      const leavePid = deferred<number>();
      let leaveFinished = false;
      const roommate = actor({
        userId: userA,
        membershipId: membershipA,
        homeId,
        role: 'ROOMMATE',
      });

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userAdmin);
        await insertHome(database.pool, homeId, 'Resolve vs leave A');
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: adminId,
          homeId,
          userId: userAdmin,
          role: 'ADMIN',
        });
        await insertOpenHousehold(database.pool, {
          id: entryId,
          homeId,
          createdByMembershipId: membershipA,
          title: 'Resolve first',
        });

        const resolve = resolveCommand(database.pool, {
          afterLock: async () => {
            resolveLocked.resolve();
            await resolveMayFinish.promise;
          },
        });
        const leave = leaveCommand(database.pool, {
          capturePid: (pid) => {
            leavePid.resolve(pid);
          },
        });

        const resolveRun = resolve({
          actor: roommate,
          homeId,
          maintenanceEntryId: entryId,
        });
        await resolveLocked.promise;
        const leaveRun = leave({
          actor: roommate,
          homeId,
          membershipId: membershipA,
        }).then(() => {
          leaveFinished = true;
        });
        const pid = await leavePid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));
        assert.equal(leaveFinished, false);
        assert.equal(await membershipEndedAt(database.pool, membershipA), null);

        resolveMayFinish.resolve();
        const resolved = await resolveRun;
        assert.equal(resolved.status, 'RESOLVED');
        assert.equal(resolved.resolvedByMembershipId, membershipA);
        assert.equal(await membershipEndedAt(database.pool, membershipA), null);
        await leaveRun;
        assert.ok(await membershipEndedAt(database.pool, membershipA));
        const row = await entryState(database.pool, entryId);
        assert.equal(row.status, 'RESOLVED');
        assert.equal(row.resolved_by_membership_id, membershipA);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userA, userAdmin],
        });
        await database.close();
      }
    },
  );

  void it(
    'actor-end winning the race conceals resolve and leaves the entry OPEN',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userAdmin = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const adminId = randomUUID();
      const entryId = randomUUID();
      const leaveLocked = deferred();
      const leaveMayFinish = deferred();
      const resolvePid = deferred<number>();
      const roommate = actor({
        userId: userA,
        membershipId: membershipA,
        homeId,
        role: 'ROOMMATE',
      });

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userAdmin);
        await insertHome(database.pool, homeId, 'Resolve vs leave B');
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: adminId,
          homeId,
          userId: userAdmin,
          role: 'ADMIN',
        });
        await insertOpenHousehold(database.pool, {
          id: entryId,
          homeId,
          createdByMembershipId: membershipA,
          title: 'Leave first',
        });

        const leave = leaveCommand(database.pool, {
          afterLock: async () => {
            leaveLocked.resolve();
            await leaveMayFinish.promise;
          },
        });
        const resolve = resolveCommand(database.pool, {
          capturePid: (pid) => {
            resolvePid.resolve(pid);
          },
        });

        const leaveRun = leave({
          actor: roommate,
          homeId,
          membershipId: membershipA,
        });
        await leaveLocked.promise;
        const resolveRun = observe(
          resolve({
            actor: roommate,
            homeId,
            maintenanceEntryId: entryId,
          }),
        );
        const pid = await resolvePid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));

        leaveMayFinish.resolve();
        await leaveRun;
        assert.ok(await membershipEndedAt(database.pool, membershipA));
        const resolved = await resolveRun;
        assert.equal(resolved.status, 'rejected');
        assert.ok(resolved.reason instanceof ConcealedNotFoundError);
        const row = await entryState(database.pool, entryId);
        assert.equal(row.status, 'OPEN');
        assert.equal(row.resolved_by_membership_id, null);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userA, userAdmin],
        });
        await database.close();
      }
    },
  );

  void it(
    'resolve winning the Home-archive race commits while the Home is active',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userId = randomUUID();
      const homeId = randomUUID();
      const membershipId = randomUUID();
      const entryId = randomUUID();
      const resolveLocked = deferred();
      const resolveMayFinish = deferred();
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
        await insertHome(database.pool, homeId, 'Resolve vs archive A');
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ADMIN',
        });
        await insertOpenHousehold(database.pool, {
          id: entryId,
          homeId,
          createdByMembershipId: membershipId,
          title: 'Resolve first archive',
        });

        const resolve = resolveCommand(database.pool, {
          afterLock: async () => {
            resolveLocked.resolve();
            await resolveMayFinish.promise;
          },
        });
        const archive = archiveCommand(database.pool, {
          capturePid: (pid) => {
            archivePid.resolve(pid);
          },
        });

        const resolveRun = resolve({
          actor: admin,
          homeId,
          maintenanceEntryId: entryId,
        });
        await resolveLocked.promise;
        const archiveRun = archive({ homeId, actor: admin }).then(() => {
          archiveFinished = true;
        });
        const pid = await archivePid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));
        assert.equal(archiveFinished, false);
        assert.equal(await homeArchivedAt(database.pool, homeId), null);

        resolveMayFinish.resolve();
        const resolved = await resolveRun;
        assert.equal(resolved.status, 'RESOLVED');
        assert.equal(resolved.resolvedByMembershipId, membershipId);
        assert.equal(await homeArchivedAt(database.pool, homeId), null);
        await archiveRun;
        assert.equal(archiveFinished, true);
        assert.ok(await homeArchivedAt(database.pool, homeId));
        const row = await entryState(database.pool, entryId);
        assert.equal(row.status, 'RESOLVED');
        assert.equal(row.resolved_by_membership_id, membershipId);
        await assert.rejects(
          () =>
            resolveCommand(database.pool)({
              actor: admin,
              homeId,
              maintenanceEntryId: entryId,
            }),
          ConcealedNotFoundError,
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
    'archive winning the race conceals resolve and leaves the historical OPEN row',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userId = randomUUID();
      const homeId = randomUUID();
      const membershipId = randomUUID();
      const entryId = randomUUID();
      const archiveLocked = deferred();
      const archiveMayFinish = deferred();
      const resolvePid = deferred<number>();
      const admin = actor({
        userId,
        membershipId,
        homeId,
        role: 'ADMIN',
      });

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, homeId, 'Resolve vs archive B');
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ADMIN',
        });
        await insertOpenHousehold(database.pool, {
          id: entryId,
          homeId,
          createdByMembershipId: membershipId,
          title: 'Archive first',
        });

        const archive = archiveCommand(database.pool, {
          afterLock: async () => {
            archiveLocked.resolve();
            await archiveMayFinish.promise;
          },
        });
        const resolve = resolveCommand(database.pool, {
          capturePid: (pid) => {
            resolvePid.resolve(pid);
          },
        });

        const archiveRun = archive({ homeId, actor: admin });
        await archiveLocked.promise;
        const resolveRun = observe(
          resolve({
            actor: admin,
            homeId,
            maintenanceEntryId: entryId,
          }),
        );
        const pid = await resolvePid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));

        archiveMayFinish.resolve();
        await archiveRun;
        assert.ok(await homeArchivedAt(database.pool, homeId));
        const resolved = await resolveRun;
        assert.equal(resolved.status, 'rejected');
        assert.ok(resolved.reason instanceof ConcealedNotFoundError);
        const row = await entryState(database.pool, entryId);
        assert.equal(row.status, 'OPEN');
        assert.equal(row.resolved_by_membership_id, null);
        assert.equal(row.resolved_at, null);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userId],
        });
        await database.close();
      }
    },
  );
});
