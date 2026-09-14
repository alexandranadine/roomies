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
import {
  SupplyAlreadyClaimedError,
  SupplyClaimNotActiveError,
} from '../../domains/supplies/errors.js';
import { createSupplyRepository } from '../../domains/supplies/repository.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import type { AppConfig } from '../../platform/config/types.js';
import { outboxWriter } from '../../platform/events/outbox-writer.js';
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
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
import { systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createClaimSupplyEntry } from './claim-supply-entry.js';
import { createCreateSupplyEntryFromPool } from './create-supply-entry.js';
import { createReleaseSupplyClaim } from './release-supply-claim.js';

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
    `INSERT INTO memberships (id, home_id, user_id, role, ended_at, ended_by_membership_id)
     VALUES ($1, $2, $3, $4, NULL, NULL)`,
    [input.id, input.homeId, input.userId, input.role],
  );
}

async function cleanup(
  pool: Pool,
  input: { homeIds: string[]; userIds: string[] },
): Promise<void> {
  if (input.homeIds.length > 0) {
    await pool.query('DELETE FROM supply_claims WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query('DELETE FROM supply_entries WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query('DELETE FROM invitations WHERE home_id = ANY($1)', [
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

function claimCommand(
  pool: Pool,
  options: {
    afterLock?: () => Promise<void>;
    capturePid?: (pid: number) => void;
  } = {},
) {
  return createClaimSupplyEntry({
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
    supplies: createSupplyRepository(pool),
    clock: systemClock,
    ids: systemUuidV7,
  });
}

function releaseCommand(
  pool: Pool,
  options: {
    afterLock?: () => Promise<void>;
    capturePid?: (pid: number) => void;
  } = {},
) {
  return createReleaseSupplyClaim({
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
    supplies: createSupplyRepository(pool),
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

function observe<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  );
}

async function activeClaimCount(pool: Pool, entryId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM supply_claims
     WHERE supply_entry_id = $1 AND released_at IS NULL`,
    [entryId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function claimState(
  pool: Pool,
  entryId: string,
): Promise<{
  releaseReason: string | null;
  releasedAt: Date | null;
  updatedAt: Date;
}> {
  const result = await pool.query<{
    release_reason: string | null;
    released_at: Date | null;
    updated_at: Date;
  }>(
    `SELECT release_reason, released_at, updated_at
     FROM supply_claims WHERE supply_entry_id = $1
     ORDER BY claimed_at DESC, id DESC LIMIT 1`,
    [entryId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('claim missing');
  }
  return {
    releaseReason: row.release_reason,
    releasedAt: row.released_at,
    updatedAt: row.updated_at,
  };
}

void describe('Supply claim/release concurrency PostgreSQL', () => {
  void it(
    'claim vs claim on the same entry yields one 201-equivalent and one already-claimed',
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
      const firstLocked = deferred();
      const firstMayFinish = deferred();
      const secondPid = deferred<number>();
      const create = createCreateSupplyEntryFromPool(database.pool);

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, homeId, 'Claim vs claim');
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
        const entry = await create({
          actor: actor({
            userId: userA,
            membershipId: membershipA,
            homeId,
            role: 'ROOMMATE',
          }),
          homeId,
          title: 'Contested',
        });

        const first = claimCommand(database.pool, {
          afterLock: async () => {
            firstLocked.resolve();
            await firstMayFinish.promise;
          },
        });
        const second = claimCommand(database.pool, {
          capturePid: (pid) => {
            secondPid.resolve(pid);
          },
        });

        const firstRun = first({
          actor: actor({
            userId: userA,
            membershipId: membershipA,
            homeId,
            role: 'ROOMMATE',
          }),
          homeId,
          supplyEntryId: entry.id,
        });
        await firstLocked.promise;
        const secondRun = observe(
          second({
            actor: actor({
              userId: userB,
              membershipId: membershipB,
              homeId,
              role: 'ROOMMATE',
            }),
            homeId,
            supplyEntryId: entry.id,
          }),
        );
        const pid = await secondPid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));
        firstMayFinish.resolve();
        const winner = await firstRun;
        const loser = await secondRun;
        assert.equal(winner.supplyEntryId, entry.id);
        assert.equal(loser.status, 'rejected');
        assert.ok(loser.reason instanceof SupplyAlreadyClaimedError);
        assert.equal(await activeClaimCount(database.pool, entry.id), 1);
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
    'claim vs membership-end: claim first then MEMBERSHIP_ENDED cleanup',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const adminId = randomUUID();
      const homeId = createUuidV7();
      const membershipA = createUuidV7();
      const adminMembership = createUuidV7();
      const claimLocked = deferred();
      const claimMayFinish = deferred();
      const leavePid = deferred<number>();
      const create = createCreateSupplyEntryFromPool(database.pool);

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, adminId);
        await insertHome(database.pool, homeId, 'Claim then end');
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: adminMembership,
          homeId,
          userId: adminId,
          role: 'ADMIN',
        });
        const entry = await create({
          actor: actor({
            userId: userA,
            membershipId: membershipA,
            homeId,
            role: 'ROOMMATE',
          }),
          homeId,
          title: 'Claim first',
        });
        const claim = claimCommand(database.pool, {
          afterLock: async () => {
            claimLocked.resolve();
            await claimMayFinish.promise;
          },
        });
        const leave = leaveCommand(database.pool, {
          capturePid: (pid) => {
            leavePid.resolve(pid);
          },
        });
        const roommate = actor({
          userId: userA,
          membershipId: membershipA,
          homeId,
          role: 'ROOMMATE',
        });
        const claimRun = claim({
          actor: roommate,
          homeId,
          supplyEntryId: entry.id,
        });
        await claimLocked.promise;
        const leaveRun = leave({
          actor: roommate,
          homeId,
          membershipId: membershipA,
        });
        const pid = await leavePid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));
        claimMayFinish.resolve();
        const claimed = await claimRun;
        assert.equal(claimed.releasedAt, null);
        await leaveRun;
        const state = await claimState(database.pool, entry.id);
        assert.equal(state.releaseReason, 'MEMBERSHIP_ENDED');
        assert.ok(state.releasedAt);
        assert.equal(await activeClaimCount(database.pool, entry.id), 0);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userA, adminId],
        });
        await database.close();
      }
    },
  );

  void it(
    'claim vs membership-end: end first conceals the later claim',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const adminId = randomUUID();
      const homeId = createUuidV7();
      const membershipA = createUuidV7();
      const adminMembership = createUuidV7();
      const leaveLocked = deferred();
      const leaveMayFinish = deferred();
      const claimPid = deferred<number>();
      const create = createCreateSupplyEntryFromPool(database.pool);

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, adminId);
        await insertHome(database.pool, homeId, 'End then claim');
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: adminMembership,
          homeId,
          userId: adminId,
          role: 'ADMIN',
        });
        const entry = await create({
          actor: actor({
            userId: userA,
            membershipId: membershipA,
            homeId,
            role: 'ROOMMATE',
          }),
          homeId,
          title: 'End first',
        });
        const leave = leaveCommand(database.pool, {
          afterLock: async () => {
            leaveLocked.resolve();
            await leaveMayFinish.promise;
          },
        });
        const claim = claimCommand(database.pool, {
          capturePid: (pid) => {
            claimPid.resolve(pid);
          },
        });
        const roommate = actor({
          userId: userA,
          membershipId: membershipA,
          homeId,
          role: 'ROOMMATE',
        });
        const leaveRun = leave({
          actor: roommate,
          homeId,
          membershipId: membershipA,
        });
        await leaveLocked.promise;
        const claimRun = observe(
          claim({
            actor: roommate,
            homeId,
            supplyEntryId: entry.id,
          }),
        );
        const pid = await claimPid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));
        leaveMayFinish.resolve();
        await leaveRun;
        const claimed = await claimRun;
        assert.equal(claimed.status, 'rejected');
        assert.ok(claimed.reason instanceof ConcealedNotFoundError);
        assert.equal(await activeClaimCount(database.pool, entry.id), 0);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userA, adminId],
        });
        await database.close();
      }
    },
  );

  void it(
    'claim vs archive both orders keep Home-first serialization',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userId = randomUUID();
      const homeClaimFirst = createUuidV7();
      const homeArchiveFirst = createUuidV7();
      const membershipClaimFirst = createUuidV7();
      const membershipArchiveFirst = createUuidV7();
      const create = createCreateSupplyEntryFromPool(database.pool);

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, homeClaimFirst, 'Claim then archive');
        await insertHome(database.pool, homeArchiveFirst, 'Archive then claim');
        await insertMembership(database.pool, {
          id: membershipClaimFirst,
          homeId: homeClaimFirst,
          userId,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipArchiveFirst,
          homeId: homeArchiveFirst,
          userId,
          role: 'ADMIN',
        });
        const entryA = await create({
          actor: actor({
            userId,
            membershipId: membershipClaimFirst,
            homeId: homeClaimFirst,
            role: 'ADMIN',
          }),
          homeId: homeClaimFirst,
          title: 'Archive after claim',
        });
        const claimLocked = deferred();
        const claimMayFinish = deferred();
        const archivePid = deferred<number>();
        const claimFirst = claimCommand(database.pool, {
          afterLock: async () => {
            claimLocked.resolve();
            await claimMayFinish.promise;
          },
        });
        const archiveWait = archiveCommand(database.pool, {
          capturePid: (pid) => {
            archivePid.resolve(pid);
          },
        });
        const adminA = actor({
          userId,
          membershipId: membershipClaimFirst,
          homeId: homeClaimFirst,
          role: 'ADMIN',
        });
        const claimRun = claimFirst({
          actor: adminA,
          homeId: homeClaimFirst,
          supplyEntryId: entryA.id,
        });
        await claimLocked.promise;
        const archiveRun = archiveWait({
          homeId: homeClaimFirst,
          actor: adminA,
        });
        await waitUntil(() =>
          archivePid.promise.then((pid) =>
            isWaitingForLock(database.pool, pid),
          ),
        );
        claimMayFinish.resolve();
        await claimRun;
        await archiveRun;
        const afterClaimFirst = await claimState(database.pool, entryA.id);
        assert.equal(afterClaimFirst.releaseReason, 'MEMBERSHIP_ENDED');
        const archived = await database.pool.query<{
          archived_at: Date | null;
        }>('SELECT archived_at FROM homes WHERE id = $1', [homeClaimFirst]);
        assert.ok(archived.rows[0]?.archived_at);
        assert.equal(await activeClaimCount(database.pool, entryA.id), 0);

        const entryB = await create({
          actor: actor({
            userId,
            membershipId: membershipArchiveFirst,
            homeId: homeArchiveFirst,
            role: 'ADMIN',
          }),
          homeId: homeArchiveFirst,
          title: 'Claim after archive',
        });
        const archiveLocked = deferred();
        const archiveMayFinish = deferred();
        const claimPid = deferred<number>();
        const archiveFirst = archiveCommand(database.pool, {
          afterLock: async () => {
            archiveLocked.resolve();
            await archiveMayFinish.promise;
          },
        });
        const claimWait = claimCommand(database.pool, {
          capturePid: (pid) => {
            claimPid.resolve(pid);
          },
        });
        const adminB = actor({
          userId,
          membershipId: membershipArchiveFirst,
          homeId: homeArchiveFirst,
          role: 'ADMIN',
        });
        const archiveFirstRun = archiveFirst({
          homeId: homeArchiveFirst,
          actor: adminB,
        });
        await archiveLocked.promise;
        const laterClaim = observe(
          claimWait({
            actor: adminB,
            homeId: homeArchiveFirst,
            supplyEntryId: entryB.id,
          }),
        );
        const pid = await claimPid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));
        archiveMayFinish.resolve();
        await archiveFirstRun;
        const later = await laterClaim;
        assert.equal(later.status, 'rejected');
        assert.ok(later.reason instanceof ConcealedNotFoundError);
        assert.equal(await activeClaimCount(database.pool, entryB.id), 0);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeClaimFirst, homeArchiveFirst],
          userIds: [userId],
        });
        await database.close();
      }
    },
  );

  void it(
    'claims on distinct entries complete without deadlock',
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
      const create = createCreateSupplyEntryFromPool(database.pool);

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, homeId, 'Distinct entries');
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
        const first = await create({
          actor: actor({
            userId: userA,
            membershipId: membershipA,
            homeId,
            role: 'ROOMMATE',
          }),
          homeId,
          title: 'Entry A',
        });
        const second = await create({
          actor: actor({
            userId: userB,
            membershipId: membershipB,
            homeId,
            role: 'ROOMMATE',
          }),
          homeId,
          title: 'Entry B',
        });
        const [claimedA, claimedB] = await Promise.all([
          claimCommand(database.pool)({
            actor: actor({
              userId: userA,
              membershipId: membershipA,
              homeId,
              role: 'ROOMMATE',
            }),
            homeId,
            supplyEntryId: first.id,
          }),
          claimCommand(database.pool)({
            actor: actor({
              userId: userB,
              membershipId: membershipB,
              homeId,
              role: 'ROOMMATE',
            }),
            homeId,
            supplyEntryId: second.id,
          }),
        ]);
        assert.equal(claimedA.supplyEntryId, first.id);
        assert.equal(claimedB.supplyEntryId, second.id);
        assert.equal(await activeClaimCount(database.pool, first.id), 1);
        assert.equal(await activeClaimCount(database.pool, second.id), 1);
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
    'release vs release yields one success and one inactive conflict',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userId = randomUUID();
      const homeId = createUuidV7();
      const membershipId = createUuidV7();
      const firstLocked = deferred();
      const firstMayFinish = deferred();
      const secondPid = deferred<number>();
      const create = createCreateSupplyEntryFromPool(database.pool);

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, homeId, 'Release vs release');
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ROOMMATE',
        });
        const entry = await create({
          actor: actor({
            userId,
            membershipId,
            homeId,
            role: 'ROOMMATE',
          }),
          homeId,
          title: 'Double release',
        });
        await claimCommand(database.pool)({
          actor: actor({
            userId,
            membershipId,
            homeId,
            role: 'ROOMMATE',
          }),
          homeId,
          supplyEntryId: entry.id,
        });
        const first = releaseCommand(database.pool, {
          afterLock: async () => {
            firstLocked.resolve();
            await firstMayFinish.promise;
          },
        });
        const second = releaseCommand(database.pool, {
          capturePid: (pid) => {
            secondPid.resolve(pid);
          },
        });
        const roommate = actor({
          userId,
          membershipId,
          homeId,
          role: 'ROOMMATE',
        });
        const firstRun = first({
          actor: roommate,
          homeId,
          supplyEntryId: entry.id,
        });
        await firstLocked.promise;
        const secondRun = observe(
          second({
            actor: roommate,
            homeId,
            supplyEntryId: entry.id,
          }),
        );
        const pid = await secondPid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));
        firstMayFinish.resolve();
        await firstRun;
        const loser = await secondRun;
        assert.equal(loser.status, 'rejected');
        assert.ok(loser.reason instanceof SupplyClaimNotActiveError);
        const state = await claimState(database.pool, entry.id);
        assert.equal(state.releaseReason, 'CLAIMANT_RELEASED');
        assert.ok(state.releasedAt);
        assert.equal(await activeClaimCount(database.pool, entry.id), 0);
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
    'release vs membership-end both orders keep the first reason immutable',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const adminId = randomUUID();
      const homeReleaseFirst = createUuidV7();
      const homeEndFirst = createUuidV7();
      const membershipReleaseFirst = createUuidV7();
      const membershipEndFirst = createUuidV7();
      const adminReleaseFirst = createUuidV7();
      const adminEndFirst = createUuidV7();
      const create = createCreateSupplyEntryFromPool(database.pool);

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, adminId);
        await insertHome(database.pool, homeReleaseFirst, 'Release then end');
        await insertHome(database.pool, homeEndFirst, 'End then release');
        await insertMembership(database.pool, {
          id: membershipReleaseFirst,
          homeId: homeReleaseFirst,
          userId: userA,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: adminReleaseFirst,
          homeId: homeReleaseFirst,
          userId: adminId,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipEndFirst,
          homeId: homeEndFirst,
          userId: userA,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: adminEndFirst,
          homeId: homeEndFirst,
          userId: adminId,
          role: 'ADMIN',
        });

        const entryA = await create({
          actor: actor({
            userId: userA,
            membershipId: membershipReleaseFirst,
            homeId: homeReleaseFirst,
            role: 'ROOMMATE',
          }),
          homeId: homeReleaseFirst,
          title: 'Release first',
        });
        await claimCommand(database.pool)({
          actor: actor({
            userId: userA,
            membershipId: membershipReleaseFirst,
            homeId: homeReleaseFirst,
            role: 'ROOMMATE',
          }),
          homeId: homeReleaseFirst,
          supplyEntryId: entryA.id,
        });
        const releaseLocked = deferred();
        const releaseMayFinish = deferred();
        const leavePid = deferred<number>();
        const releaseFirst = releaseCommand(database.pool, {
          afterLock: async () => {
            releaseLocked.resolve();
            await releaseMayFinish.promise;
          },
        });
        const leaveWait = leaveCommand(database.pool, {
          capturePid: (pid) => {
            leavePid.resolve(pid);
          },
        });
        const roommateA = actor({
          userId: userA,
          membershipId: membershipReleaseFirst,
          homeId: homeReleaseFirst,
          role: 'ROOMMATE',
        });
        const releaseRun = releaseFirst({
          actor: roommateA,
          homeId: homeReleaseFirst,
          supplyEntryId: entryA.id,
        });
        await releaseLocked.promise;
        const leaveRun = leaveWait({
          actor: roommateA,
          homeId: homeReleaseFirst,
          membershipId: membershipReleaseFirst,
        });
        const pid = await leavePid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));
        releaseMayFinish.resolve();
        await releaseRun;
        const afterManual = await claimState(database.pool, entryA.id);
        await leaveRun;
        const afterEnd = await claimState(database.pool, entryA.id);
        assert.equal(afterManual.releaseReason, 'CLAIMANT_RELEASED');
        assert.equal(afterEnd.releaseReason, 'CLAIMANT_RELEASED');
        assert.equal(
          afterEnd.releasedAt?.getTime(),
          afterManual.releasedAt?.getTime(),
        );

        const entryB = await create({
          actor: actor({
            userId: userA,
            membershipId: membershipEndFirst,
            homeId: homeEndFirst,
            role: 'ROOMMATE',
          }),
          homeId: homeEndFirst,
          title: 'End first',
        });
        await claimCommand(database.pool)({
          actor: actor({
            userId: userA,
            membershipId: membershipEndFirst,
            homeId: homeEndFirst,
            role: 'ROOMMATE',
          }),
          homeId: homeEndFirst,
          supplyEntryId: entryB.id,
        });
        const endLocked = deferred();
        const endMayFinish = deferred();
        const releasePid = deferred<number>();
        const leaveFirst = leaveCommand(database.pool, {
          afterLock: async () => {
            endLocked.resolve();
            await endMayFinish.promise;
          },
        });
        const releaseWait = releaseCommand(database.pool, {
          capturePid: (pid) => {
            releasePid.resolve(pid);
          },
        });
        const roommateB = actor({
          userId: userA,
          membershipId: membershipEndFirst,
          homeId: homeEndFirst,
          role: 'ROOMMATE',
        });
        const leaveFirstRun = leaveFirst({
          actor: roommateB,
          homeId: homeEndFirst,
          membershipId: membershipEndFirst,
        });
        await endLocked.promise;
        const laterRelease = observe(
          releaseWait({
            actor: roommateB,
            homeId: homeEndFirst,
            supplyEntryId: entryB.id,
          }),
        );
        const laterPid = await releasePid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, laterPid));
        endMayFinish.resolve();
        await leaveFirstRun;
        const later = await laterRelease;
        assert.equal(later.status, 'rejected');
        assert.ok(later.reason instanceof ConcealedNotFoundError);
        const endedState = await claimState(database.pool, entryB.id);
        assert.equal(endedState.releaseReason, 'MEMBERSHIP_ENDED');
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeReleaseFirst, homeEndFirst],
          userIds: [userA, adminId],
        });
        await database.close();
      }
    },
  );
});
