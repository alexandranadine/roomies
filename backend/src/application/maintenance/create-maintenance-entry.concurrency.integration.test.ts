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
import { createMaintenanceRepository } from '../../domains/maintenance/repository.js';
import { findActiveExactMembershipIdsInHome } from '../../domains/memberships/find-active-exact-membership-ids-in-home.js';
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
import { createCreateMaintenanceEntry } from './create-maintenance-entry.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();

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

function createMaintenanceCommand(
  pool: Pool,
  options: {
    afterLock?: () => Promise<void>;
    capturePid?: (pid: number) => void;
  } = {},
) {
  return createCreateMaintenanceEntry({
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
    findActiveExactMembershipIdsInHome,
    maintenance: createMaintenanceRepository(pool),
    clock: systemClock,
    ids: systemUuidV7,
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
      createApplyMembershipEndingWithinHomeStructureFromPool(pool),
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
    endMembership: createEndMembershipWithinHomeStructureFromPool(pool),
  });
}

async function entryCount(pool: Pool, homeId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM maintenance_entries WHERE home_id = $1`,
    [homeId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function audienceMembershipIds(
  pool: Pool,
  maintenanceEntryId: string,
): Promise<readonly string[]> {
  const result = await pool.query<{ membership_id: string }>(
    `SELECT membership_id FROM maintenance_audiences
     WHERE maintenance_entry_id = $1
     ORDER BY membership_id ASC`,
    [maintenanceEntryId],
  );
  return result.rows.map((row) => row.membership_id);
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

void describe('Maintenance create concurrency PostgreSQL', () => {
  void it(
    'private create winning the recipient-end race keeps the historical audience',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const adminId = randomUUID();
      const actorId = randomUUID();
      const recipientId = randomUUID();
      const homeId = randomUUID();
      const adminMembershipId = randomUUID();
      const actorMembershipId = randomUUID();
      const recipientMembershipId = randomUUID();
      const createLocked = deferred();
      const createMayFinish = deferred();
      const leavePid = deferred<number>();
      let leaveFinished = false;
      const roommate = actor({
        userId: actorId,
        membershipId: actorMembershipId,
        homeId,
        role: 'ROOMMATE',
      });
      const recipient = actor({
        userId: recipientId,
        membershipId: recipientMembershipId,
        homeId,
        role: 'ROOMMATE',
      });

      try {
        await insertUser(database.pool, adminId);
        await insertUser(database.pool, actorId);
        await insertUser(database.pool, recipientId);
        await insertHome(database.pool, homeId, 'Recipient-end race A');
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
        await insertMembership(database.pool, {
          id: recipientMembershipId,
          homeId,
          userId: recipientId,
          role: 'ROOMMATE',
        });

        const create = createMaintenanceCommand(database.pool, {
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
        const repository = createMaintenanceRepository(database.pool);

        const createRun = create({
          actor: roommate,
          homeId,
          visibility: 'PRIVATE',
          title: 'Create wins recipient-end',
          audienceMembershipIds: [recipientMembershipId],
        });
        await createLocked.promise;

        const leaveRun = leave({
          actor: recipient,
          homeId,
          membershipId: recipientMembershipId,
        }).then(() => {
          leaveFinished = true;
        });
        const pid = await leavePid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));
        assert.equal(leaveFinished, false);
        assert.equal(
          await membershipEndedAt(database.pool, recipientMembershipId),
          null,
        );

        createMayFinish.resolve();
        const created = await createRun;
        assert.equal(created.visibility, 'PRIVATE');
        assert.equal(created.createdByMembershipId, actorMembershipId);
        assert.equal(
          await membershipEndedAt(database.pool, recipientMembershipId),
          null,
        );
        await leaveRun;
        assert.ok(
          await membershipEndedAt(database.pool, recipientMembershipId),
        );
        assert.deepEqual(
          await audienceMembershipIds(database.pool, created.id),
          [actorMembershipId, recipientMembershipId].sort((left, right) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        );
        assert.equal(
          (
            await repository.findVisibleByHomeAndId(
              homeId,
              created.id,
              recipientMembershipId,
            )
          )?.id,
          undefined,
        );
        assert.equal(
          (
            await repository.findVisibleByHomeAndId(
              homeId,
              created.id,
              actorMembershipId,
            )
          )?.id,
          created.id,
        );
        assert.equal(await entryCount(database.pool, homeId), 1);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [adminId, actorId, recipientId],
        });
        await database.close();
      }
    },
  );

  void it(
    'recipient-end winning the race conceals create and writes no rows',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const adminId = randomUUID();
      const actorId = randomUUID();
      const recipientId = randomUUID();
      const homeId = randomUUID();
      const adminMembershipId = randomUUID();
      const actorMembershipId = randomUUID();
      const recipientMembershipId = randomUUID();
      const leaveLocked = deferred();
      const leaveMayFinish = deferred();
      const createPid = deferred<number>();
      const roommate = actor({
        userId: actorId,
        membershipId: actorMembershipId,
        homeId,
        role: 'ROOMMATE',
      });
      const recipient = actor({
        userId: recipientId,
        membershipId: recipientMembershipId,
        homeId,
        role: 'ROOMMATE',
      });

      try {
        await insertUser(database.pool, adminId);
        await insertUser(database.pool, actorId);
        await insertUser(database.pool, recipientId);
        await insertHome(database.pool, homeId, 'Recipient-end race B');
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
        await insertMembership(database.pool, {
          id: recipientMembershipId,
          homeId,
          userId: recipientId,
          role: 'ROOMMATE',
        });

        const leave = leaveCommand(database.pool, {
          afterLock: async () => {
            leaveLocked.resolve();
            await leaveMayFinish.promise;
          },
        });
        const create = createMaintenanceCommand(database.pool, {
          capturePid: (pid) => {
            createPid.resolve(pid);
          },
        });

        const leaveRun = leave({
          actor: recipient,
          homeId,
          membershipId: recipientMembershipId,
        });
        await leaveLocked.promise;

        const createRun = observe(
          create({
            actor: roommate,
            homeId,
            visibility: 'PRIVATE',
            title: 'Recipient-end wins create',
            audienceMembershipIds: [recipientMembershipId],
          }),
        );
        const pid = await createPid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));

        leaveMayFinish.resolve();
        await leaveRun;
        assert.ok(
          await membershipEndedAt(database.pool, recipientMembershipId),
        );
        const created = await createRun;
        assert.equal(created.status, 'rejected');
        assert.ok(created.reason instanceof ConcealedNotFoundError);
        assert.equal((created.reason as Error).message, 'Not found');
        assert.doesNotMatch(
          (created.reason as Error).message,
          /foreign|ended|recipient|Membership/i,
        );
        assert.equal(await entryCount(database.pool, homeId), 0);
        const leftover = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM maintenance_audiences WHERE home_id = $1`,
          [homeId],
        );
        assert.equal(Number(leftover.rows[0]?.count ?? '0'), 0);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [adminId, actorId, recipientId],
        });
        await database.close();
      }
    },
  );

  void it(
    'create winning the actor-end race commits while the actor is active',
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
      const createLocked = deferred();
      const createMayFinish = deferred();
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

        const create = createMaintenanceCommand(database.pool, {
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
        const repository = createMaintenanceRepository(database.pool);

        const createRun = create({
          actor: roommate,
          homeId,
          visibility: 'PRIVATE',
          title: 'Create wins actor-end',
          audienceMembershipIds: [],
        });
        await createLocked.promise;

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

        createMayFinish.resolve();
        const created = await createRun;
        assert.equal(created.createdByMembershipId, actorMembershipId);
        assert.equal(
          await membershipEndedAt(database.pool, actorMembershipId),
          null,
        );
        await leaveRun;
        assert.ok(await membershipEndedAt(database.pool, actorMembershipId));
        assert.deepEqual(
          await audienceMembershipIds(database.pool, created.id),
          [actorMembershipId],
        );
        assert.equal(
          await repository.findVisibleByHomeAndId(
            homeId,
            created.id,
            actorMembershipId,
          ),
          null,
        );
        assert.equal(await entryCount(database.pool, homeId), 1);
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
    'actor-end winning the race conceals create and inserts no rows',
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
      const leaveLocked = deferred();
      const leaveMayFinish = deferred();
      const createPid = deferred<number>();
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

        const leave = leaveCommand(database.pool, {
          afterLock: async () => {
            leaveLocked.resolve();
            await leaveMayFinish.promise;
          },
        });
        const create = createMaintenanceCommand(database.pool, {
          capturePid: (pid) => {
            createPid.resolve(pid);
          },
        });

        const leaveRun = leave({
          actor: roommate,
          homeId,
          membershipId: actorMembershipId,
        });
        await leaveLocked.promise;

        const createRun = observe(
          create({
            actor: roommate,
            homeId,
            visibility: 'PRIVATE',
            title: 'Actor-end wins create',
            audienceMembershipIds: [],
          }),
        );
        const pid = await createPid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));

        leaveMayFinish.resolve();
        await leaveRun;
        assert.ok(await membershipEndedAt(database.pool, actorMembershipId));
        const created = await createRun;
        assert.equal(created.status, 'rejected');
        assert.ok(created.reason instanceof ConcealedNotFoundError);
        assert.equal(await entryCount(database.pool, homeId), 0);
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
    'create winning the Home-archive race commits while the Home is active',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userId = randomUUID();
      const homeId = randomUUID();
      const membershipId = randomUUID();
      const createLocked = deferred();
      const createMayFinish = deferred();
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

        const create = createMaintenanceCommand(database.pool, {
          afterLock: async () => {
            createLocked.resolve();
            await createMayFinish.promise;
          },
        });
        const archive = archiveCommand(database.pool, {
          capturePid: (pid) => {
            archivePid.resolve(pid);
          },
        });
        const repository = createMaintenanceRepository(database.pool);

        const createRun = create({
          actor: admin,
          homeId,
          visibility: 'PRIVATE',
          title: 'Create wins archive',
          audienceMembershipIds: [],
        });
        await createLocked.promise;

        const archiveRun = archive({ homeId, actor: admin }).then(() => {
          archiveFinished = true;
        });
        const pid = await archivePid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));
        assert.equal(archiveFinished, false);
        assert.equal(await homeArchivedAt(database.pool, homeId), null);

        createMayFinish.resolve();
        const created = await createRun;
        assert.equal(created.visibility, 'PRIVATE');
        assert.equal(await homeArchivedAt(database.pool, homeId), null);
        await archiveRun;
        assert.equal(archiveFinished, true);
        assert.ok(await homeArchivedAt(database.pool, homeId));
        assert.equal(await entryCount(database.pool, homeId), 1);
        assert.deepEqual(
          await audienceMembershipIds(database.pool, created.id),
          [membershipId],
        );
        assert.equal(
          await repository.findVisibleByHomeAndId(
            homeId,
            created.id,
            membershipId,
          ),
          null,
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
    'archive winning the race conceals create and inserts no rows',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userId = randomUUID();
      const homeId = randomUUID();
      const membershipId = randomUUID();
      const archiveLocked = deferred();
      const archiveMayFinish = deferred();
      const createPid = deferred<number>();
      let createFinished = false;
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

        const archive = archiveCommand(database.pool, {
          afterLock: async () => {
            archiveLocked.resolve();
            await archiveMayFinish.promise;
          },
        });
        const create = createMaintenanceCommand(database.pool, {
          capturePid: (pid) => {
            createPid.resolve(pid);
          },
        });

        const archiveRun = archive({ homeId, actor: admin });
        await archiveLocked.promise;

        const createRun = observe(
          create({
            actor: admin,
            homeId,
            visibility: 'PRIVATE',
            title: 'Archive wins create',
            audienceMembershipIds: [],
          }).finally(() => {
            createFinished = true;
          }),
        );
        const pid = await createPid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));
        assert.equal(createFinished, false);

        archiveMayFinish.resolve();
        await archiveRun;
        assert.ok(await homeArchivedAt(database.pool, homeId));
        const created = await createRun;
        assert.equal(created.status, 'rejected');
        assert.ok(created.reason instanceof ConcealedNotFoundError);
        assert.equal(await entryCount(database.pool, homeId), 0);
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
