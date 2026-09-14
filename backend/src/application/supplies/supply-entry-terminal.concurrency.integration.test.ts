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
  SupplyClaimNotActiveError,
  SupplyNotOpenError,
} from '../../domains/supplies/errors.js';
import { createSupplyRepository } from '../../domains/supplies/repository.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import type { AppConfig } from '../../platform/config/types.js';
import { outboxWriter } from '../../platform/events/outbox-writer.js';
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
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
import { createCancelSupplyEntry } from './cancel-supply-entry.js';
import { createClaimSupplyEntry } from './claim-supply-entry.js';
import { createCreateSupplyEntryFromPool } from './create-supply-entry.js';
import { createMarkSupplyEntryObtained } from './mark-supply-entry-obtained.js';
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

function claimCommand(pool: Pool, options: LockHooks = {}) {
  return createClaimSupplyEntry({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeAndExactMemberships: wrapHomeLock(options),
    supplies: createSupplyRepository(pool),
    clock: systemClock,
    ids: systemUuidV7,
  });
}

function releaseCommand(pool: Pool, options: LockHooks = {}) {
  return createReleaseSupplyClaim({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeAndExactMemberships: wrapHomeLock(options),
    supplies: createSupplyRepository(pool),
    clock: systemClock,
  });
}

function obtainCommand(pool: Pool, options: LockHooks = {}) {
  return createMarkSupplyEntryObtained({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeAndExactMemberships: wrapHomeLock(options),
    supplies: createSupplyRepository(pool),
    outbox: outboxWriter,
    clock: systemClock,
    ids: systemUuidV7,
  });
}

function cancelCommand(pool: Pool, options: LockHooks = {}) {
  return createCancelSupplyEntry({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeAndExactMemberships: wrapHomeLock(options),
    supplies: createSupplyRepository(pool),
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

function observe<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  );
}

async function entryStatus(pool: Pool, entryId: string): Promise<string> {
  const result = await pool.query<{ status: string }>(
    'SELECT status FROM supply_entries WHERE id = $1',
    [entryId],
  );
  return result.rows[0]?.status ?? '';
}

async function entryActor(
  pool: Pool,
  entryId: string,
): Promise<{
  status: string;
  obtainedByMembershipId: string | null;
}> {
  const result = await pool.query<{
    status: string;
    obtained_by_membership_id: string | null;
  }>(
    'SELECT status, obtained_by_membership_id FROM supply_entries WHERE id = $1',
    [entryId],
  );
  return {
    status: result.rows[0]?.status ?? '',
    obtainedByMembershipId: result.rows[0]?.obtained_by_membership_id ?? null,
  };
}

async function claimReason(
  pool: Pool,
  entryId: string,
): Promise<string | null> {
  const result = await pool.query<{ release_reason: string | null }>(
    `SELECT release_reason FROM supply_claims
     WHERE supply_entry_id = $1
     ORDER BY claimed_at DESC, id DESC LIMIT 1`,
    [entryId],
  );
  return result.rows[0]?.release_reason ?? null;
}

async function activeClaimCount(pool: Pool, entryId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM supply_claims
     WHERE supply_entry_id = $1 AND released_at IS NULL`,
    [entryId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

void describe('Supply obtain/cancel concurrency PostgreSQL', () => {
  void it(
    'claim vs obtain and claim vs cancel serialize on Home with both orders',
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
        await insertHome(database.pool, homeId, 'Claim vs terminal');
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

        const claimFirstObtain = await create({
          actor: roommateA,
          homeId,
          title: 'Claim then obtain',
        });
        const claimLocked = deferred();
        const claimMayFinish = deferred();
        const obtainPid = deferred<number>();
        const claimRun = claimCommand(database.pool, {
          afterLock: async () => {
            claimLocked.resolve();
            await claimMayFinish.promise;
          },
        })({
          actor: roommateA,
          homeId,
          supplyEntryId: claimFirstObtain.id,
        });
        await claimLocked.promise;
        const laterObtain = observe(
          obtainCommand(database.pool, {
            capturePid: (pid) => {
              obtainPid.resolve(pid);
            },
          })({
            actor: roommateB,
            homeId,
            supplyEntryId: claimFirstObtain.id,
          }),
        );
        await waitUntil(() =>
          obtainPid.promise.then((pid) => isWaitingForLock(database.pool, pid)),
        );
        claimMayFinish.resolve();
        await claimRun;
        const obtained = await laterObtain;
        assert.equal(obtained.status, 'fulfilled');
        assert.equal(obtained.value.status, 'OBTAINED');
        assert.equal(
          await claimReason(database.pool, claimFirstObtain.id),
          'ENTRY_OBTAINED',
        );
        assert.equal(
          await activeClaimCount(database.pool, claimFirstObtain.id),
          0,
        );

        const obtainFirst = await create({
          actor: roommateA,
          homeId,
          title: 'Obtain then claim',
        });
        const obtainLocked = deferred();
        const obtainMayFinish = deferred();
        const claimPid = deferred<number>();
        const obtainRun = obtainCommand(database.pool, {
          afterLock: async () => {
            obtainLocked.resolve();
            await obtainMayFinish.promise;
          },
        })({
          actor: roommateB,
          homeId,
          supplyEntryId: obtainFirst.id,
        });
        await obtainLocked.promise;
        const laterClaim = observe(
          claimCommand(database.pool, {
            capturePid: (pid) => {
              claimPid.resolve(pid);
            },
          })({
            actor: roommateA,
            homeId,
            supplyEntryId: obtainFirst.id,
          }),
        );
        await waitUntil(() =>
          claimPid.promise.then((pid) => isWaitingForLock(database.pool, pid)),
        );
        obtainMayFinish.resolve();
        await obtainRun;
        const claimed = await laterClaim;
        assert.equal(claimed.status, 'rejected');
        assert.ok(claimed.reason instanceof SupplyNotOpenError);
        assert.equal(
          await entryStatus(database.pool, obtainFirst.id),
          'OBTAINED',
        );
        assert.equal(await activeClaimCount(database.pool, obtainFirst.id), 0);

        const claimFirstCancel = await create({
          actor: roommateA,
          homeId,
          title: 'Claim then cancel',
        });
        const claim2Locked = deferred();
        const claim2MayFinish = deferred();
        const cancelPid = deferred<number>();
        const claim2Run = claimCommand(database.pool, {
          afterLock: async () => {
            claim2Locked.resolve();
            await claim2MayFinish.promise;
          },
        })({
          actor: roommateA,
          homeId,
          supplyEntryId: claimFirstCancel.id,
        });
        await claim2Locked.promise;
        const laterCancel = observe(
          cancelCommand(database.pool, {
            capturePid: (pid) => {
              cancelPid.resolve(pid);
            },
          })({
            actor: roommateB,
            homeId,
            supplyEntryId: claimFirstCancel.id,
          }),
        );
        await waitUntil(() =>
          cancelPid.promise.then((pid) => isWaitingForLock(database.pool, pid)),
        );
        claim2MayFinish.resolve();
        await claim2Run;
        const canceled = await laterCancel;
        assert.equal(canceled.status, 'fulfilled');
        assert.equal(canceled.value.status, 'CANCELED');
        assert.equal(
          await claimReason(database.pool, claimFirstCancel.id),
          'ENTRY_CANCELED',
        );

        const cancelFirst = await create({
          actor: roommateA,
          homeId,
          title: 'Cancel then claim',
        });
        const cancelLocked = deferred();
        const cancelMayFinish = deferred();
        const claim3Pid = deferred<number>();
        const cancelRun = cancelCommand(database.pool, {
          afterLock: async () => {
            cancelLocked.resolve();
            await cancelMayFinish.promise;
          },
        })({
          actor: roommateB,
          homeId,
          supplyEntryId: cancelFirst.id,
        });
        await cancelLocked.promise;
        const laterClaim2 = observe(
          claimCommand(database.pool, {
            capturePid: (pid) => {
              claim3Pid.resolve(pid);
            },
          })({
            actor: roommateA,
            homeId,
            supplyEntryId: cancelFirst.id,
          }),
        );
        await waitUntil(() =>
          claim3Pid.promise.then((pid) => isWaitingForLock(database.pool, pid)),
        );
        cancelMayFinish.resolve();
        await cancelRun;
        const claimedAfterCancel = await laterClaim2;
        assert.equal(claimedAfterCancel.status, 'rejected');
        assert.ok(claimedAfterCancel.reason instanceof SupplyNotOpenError);
        assert.equal(
          await entryStatus(database.pool, cancelFirst.id),
          'CANCELED',
        );
        assert.equal(await activeClaimCount(database.pool, cancelFirst.id), 0);
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
    'manual release vs obtain and cancel keep the first reason immutable',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userId = randomUUID();
      const homeId = createUuidV7();
      const membershipId = createUuidV7();
      const create = createCreateSupplyEntryFromPool(database.pool);

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, homeId, 'Release vs terminal');
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ROOMMATE',
        });
        const roommate = actor({
          userId,
          membershipId,
          homeId,
          role: 'ROOMMATE',
        });

        const releaseThenObtain = await create({
          actor: roommate,
          homeId,
          title: 'Release then obtain',
        });
        await claimCommand(database.pool)({
          actor: roommate,
          homeId,
          supplyEntryId: releaseThenObtain.id,
        });
        const releaseLocked = deferred();
        const releaseMayFinish = deferred();
        const obtainPid = deferred<number>();
        const releaseRun = releaseCommand(database.pool, {
          afterLock: async () => {
            releaseLocked.resolve();
            await releaseMayFinish.promise;
          },
        })({
          actor: roommate,
          homeId,
          supplyEntryId: releaseThenObtain.id,
        });
        await releaseLocked.promise;
        const laterObtain = observe(
          obtainCommand(database.pool, {
            capturePid: (pid) => {
              obtainPid.resolve(pid);
            },
          })({
            actor: roommate,
            homeId,
            supplyEntryId: releaseThenObtain.id,
          }),
        );
        await waitUntil(() =>
          obtainPid.promise.then((pid) => isWaitingForLock(database.pool, pid)),
        );
        releaseMayFinish.resolve();
        await releaseRun;
        const obtained = await laterObtain;
        assert.equal(obtained.status, 'fulfilled');
        assert.equal(
          await claimReason(database.pool, releaseThenObtain.id),
          'CLAIMANT_RELEASED',
        );
        assert.equal(
          await entryStatus(database.pool, releaseThenObtain.id),
          'OBTAINED',
        );

        const obtainThenRelease = await create({
          actor: roommate,
          homeId,
          title: 'Obtain then release',
        });
        await claimCommand(database.pool)({
          actor: roommate,
          homeId,
          supplyEntryId: obtainThenRelease.id,
        });
        const obtainLocked = deferred();
        const obtainMayFinish = deferred();
        const releasePid = deferred<number>();
        const obtainRun = obtainCommand(database.pool, {
          afterLock: async () => {
            obtainLocked.resolve();
            await obtainMayFinish.promise;
          },
        })({
          actor: roommate,
          homeId,
          supplyEntryId: obtainThenRelease.id,
        });
        await obtainLocked.promise;
        const laterRelease = observe(
          releaseCommand(database.pool, {
            capturePid: (pid) => {
              releasePid.resolve(pid);
            },
          })({
            actor: roommate,
            homeId,
            supplyEntryId: obtainThenRelease.id,
          }),
        );
        await waitUntil(() =>
          releasePid.promise.then((pid) =>
            isWaitingForLock(database.pool, pid),
          ),
        );
        obtainMayFinish.resolve();
        await obtainRun;
        const released = await laterRelease;
        assert.equal(released.status, 'rejected');
        assert.ok(released.reason instanceof SupplyClaimNotActiveError);
        assert.equal(
          await claimReason(database.pool, obtainThenRelease.id),
          'ENTRY_OBTAINED',
        );

        const releaseThenCancel = await create({
          actor: roommate,
          homeId,
          title: 'Release then cancel',
        });
        await claimCommand(database.pool)({
          actor: roommate,
          homeId,
          supplyEntryId: releaseThenCancel.id,
        });
        const release2Locked = deferred();
        const release2MayFinish = deferred();
        const cancelPid = deferred<number>();
        const release2Run = releaseCommand(database.pool, {
          afterLock: async () => {
            release2Locked.resolve();
            await release2MayFinish.promise;
          },
        })({
          actor: roommate,
          homeId,
          supplyEntryId: releaseThenCancel.id,
        });
        await release2Locked.promise;
        const laterCancel = observe(
          cancelCommand(database.pool, {
            capturePid: (pid) => {
              cancelPid.resolve(pid);
            },
          })({
            actor: roommate,
            homeId,
            supplyEntryId: releaseThenCancel.id,
          }),
        );
        await waitUntil(() =>
          cancelPid.promise.then((pid) => isWaitingForLock(database.pool, pid)),
        );
        release2MayFinish.resolve();
        await release2Run;
        const canceled = await laterCancel;
        assert.equal(canceled.status, 'fulfilled');
        assert.equal(
          await claimReason(database.pool, releaseThenCancel.id),
          'CLAIMANT_RELEASED',
        );
        assert.equal(
          await entryStatus(database.pool, releaseThenCancel.id),
          'CANCELED',
        );

        const cancelThenRelease = await create({
          actor: roommate,
          homeId,
          title: 'Cancel then release',
        });
        await claimCommand(database.pool)({
          actor: roommate,
          homeId,
          supplyEntryId: cancelThenRelease.id,
        });
        const cancelLocked = deferred();
        const cancelMayFinish = deferred();
        const release3Pid = deferred<number>();
        const cancelRun = cancelCommand(database.pool, {
          afterLock: async () => {
            cancelLocked.resolve();
            await cancelMayFinish.promise;
          },
        })({
          actor: roommate,
          homeId,
          supplyEntryId: cancelThenRelease.id,
        });
        await cancelLocked.promise;
        const laterRelease2 = observe(
          releaseCommand(database.pool, {
            capturePid: (pid) => {
              release3Pid.resolve(pid);
            },
          })({
            actor: roommate,
            homeId,
            supplyEntryId: cancelThenRelease.id,
          }),
        );
        await waitUntil(() =>
          release3Pid.promise.then((pid) =>
            isWaitingForLock(database.pool, pid),
          ),
        );
        cancelMayFinish.resolve();
        await cancelRun;
        const released2 = await laterRelease2;
        assert.equal(released2.status, 'rejected');
        assert.ok(released2.reason instanceof SupplyClaimNotActiveError);
        assert.equal(
          await claimReason(database.pool, cancelThenRelease.id),
          'ENTRY_CANCELED',
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
    'obtain vs cancel, obtain vs obtain, and cancel vs cancel yield one winner',
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
        await insertHome(database.pool, homeId, 'Terminal vs terminal');
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

        const obtainVsCancel = await create({
          actor: roommateA,
          homeId,
          title: 'Obtain vs cancel',
        });
        const obtainLocked = deferred();
        const obtainMayFinish = deferred();
        const cancelPid = deferred<number>();
        const obtainRun = obtainCommand(database.pool, {
          afterLock: async () => {
            obtainLocked.resolve();
            await obtainMayFinish.promise;
          },
        })({
          actor: roommateA,
          homeId,
          supplyEntryId: obtainVsCancel.id,
        });
        await obtainLocked.promise;
        const laterCancel = observe(
          cancelCommand(database.pool, {
            capturePid: (pid) => {
              cancelPid.resolve(pid);
            },
          })({
            actor: roommateB,
            homeId,
            supplyEntryId: obtainVsCancel.id,
          }),
        );
        await waitUntil(() =>
          cancelPid.promise.then((pid) => isWaitingForLock(database.pool, pid)),
        );
        obtainMayFinish.resolve();
        const obtained = await obtainRun;
        const canceled = await laterCancel;
        assert.equal(obtained.status, 'OBTAINED');
        assert.equal(obtained.obtainedByMembershipId, membershipA);
        assert.notEqual(obtained.obtainedByMembershipId, membershipB);
        assert.equal(canceled.status, 'rejected');
        assert.ok(canceled.reason instanceof SupplyNotOpenError);
        const obtainVsCancelRow = await entryActor(
          database.pool,
          obtainVsCancel.id,
        );
        assert.equal(obtainVsCancelRow.status, 'OBTAINED');
        assert.equal(obtainVsCancelRow.obtainedByMembershipId, membershipA);

        const cancelVsObtain = await create({
          actor: roommateA,
          homeId,
          title: 'Cancel vs obtain',
        });
        const cancelLocked = deferred();
        const cancelMayFinish = deferred();
        const obtainPid = deferred<number>();
        const cancelRun = cancelCommand(database.pool, {
          afterLock: async () => {
            cancelLocked.resolve();
            await cancelMayFinish.promise;
          },
        })({
          actor: roommateA,
          homeId,
          supplyEntryId: cancelVsObtain.id,
        });
        await cancelLocked.promise;
        const laterObtain = observe(
          obtainCommand(database.pool, {
            capturePid: (pid) => {
              obtainPid.resolve(pid);
            },
          })({
            actor: roommateB,
            homeId,
            supplyEntryId: cancelVsObtain.id,
          }),
        );
        await waitUntil(() =>
          obtainPid.promise.then((pid) => isWaitingForLock(database.pool, pid)),
        );
        cancelMayFinish.resolve();
        await cancelRun;
        const obtainedLater = await laterObtain;
        assert.equal(obtainedLater.status, 'rejected');
        assert.ok(obtainedLater.reason instanceof SupplyNotOpenError);
        const cancelVsObtainRow = await entryActor(
          database.pool,
          cancelVsObtain.id,
        );
        assert.equal(cancelVsObtainRow.status, 'CANCELED');
        assert.equal(cancelVsObtainRow.obtainedByMembershipId, null);

        const obtainVsObtain = await create({
          actor: roommateA,
          homeId,
          title: 'Obtain vs obtain',
        });
        await claimCommand(database.pool)({
          actor: roommateA,
          homeId,
          supplyEntryId: obtainVsObtain.id,
        });
        const firstObtainLocked = deferred();
        const firstObtainMayFinish = deferred();
        const secondObtainPid = deferred<number>();
        const firstObtain = obtainCommand(database.pool, {
          afterLock: async () => {
            firstObtainLocked.resolve();
            await firstObtainMayFinish.promise;
          },
        })({
          actor: roommateB,
          homeId,
          supplyEntryId: obtainVsObtain.id,
        });
        await firstObtainLocked.promise;
        const secondObtain = observe(
          obtainCommand(database.pool, {
            capturePid: (pid) => {
              secondObtainPid.resolve(pid);
            },
          })({
            actor: roommateA,
            homeId,
            supplyEntryId: obtainVsObtain.id,
          }),
        );
        await waitUntil(() =>
          secondObtainPid.promise.then((pid) =>
            isWaitingForLock(database.pool, pid),
          ),
        );
        firstObtainMayFinish.resolve();
        const winnerObtain = await firstObtain;
        const second = await secondObtain;
        assert.equal(winnerObtain.status, 'OBTAINED');
        assert.equal(winnerObtain.obtainedByMembershipId, membershipB);
        assert.notEqual(winnerObtain.obtainedByMembershipId, membershipA);
        assert.notEqual(
          winnerObtain.obtainedByMembershipId,
          obtainVsObtain.createdByMembershipId,
        );
        assert.equal(second.status, 'rejected');
        assert.ok(second.reason instanceof SupplyNotOpenError);
        const obtainVsObtainRow = await entryActor(
          database.pool,
          obtainVsObtain.id,
        );
        assert.equal(obtainVsObtainRow.status, 'OBTAINED');
        assert.equal(obtainVsObtainRow.obtainedByMembershipId, membershipB);
        assert.equal(
          await activeClaimCount(database.pool, obtainVsObtain.id),
          0,
        );
        assert.equal(
          await claimReason(database.pool, obtainVsObtain.id),
          'ENTRY_OBTAINED',
        );

        const cancelVsCancel = await create({
          actor: roommateA,
          homeId,
          title: 'Cancel vs cancel',
        });
        const firstCancelLocked = deferred();
        const firstCancelMayFinish = deferred();
        const secondCancelPid = deferred<number>();
        const firstCancel = cancelCommand(database.pool, {
          afterLock: async () => {
            firstCancelLocked.resolve();
            await firstCancelMayFinish.promise;
          },
        })({
          actor: roommateA,
          homeId,
          supplyEntryId: cancelVsCancel.id,
        });
        await firstCancelLocked.promise;
        const secondCancel = observe(
          cancelCommand(database.pool, {
            capturePid: (pid) => {
              secondCancelPid.resolve(pid);
            },
          })({
            actor: roommateB,
            homeId,
            supplyEntryId: cancelVsCancel.id,
          }),
        );
        await waitUntil(() =>
          secondCancelPid.promise.then((pid) =>
            isWaitingForLock(database.pool, pid),
          ),
        );
        firstCancelMayFinish.resolve();
        await firstCancel;
        const secondCanceled = await secondCancel;
        assert.equal(secondCanceled.status, 'rejected');
        assert.ok(secondCanceled.reason instanceof SupplyNotOpenError);
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
    'obtain/cancel vs membership-end keep Home-first serialization',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const adminId = randomUUID();
      const homeObtainFirst = createUuidV7();
      const homeEndFirst = createUuidV7();
      const homeCancelFirst = createUuidV7();
      const homeEndThenCancel = createUuidV7();
      const roommateObtainFirst = createUuidV7();
      const adminObtainFirst = createUuidV7();
      const roommateEndFirst = createUuidV7();
      const adminEndFirst = createUuidV7();
      const roommateCancelFirst = createUuidV7();
      const adminCancelFirst = createUuidV7();
      const roommateEndThenCancel = createUuidV7();
      const adminEndThenCancel = createUuidV7();
      const create = createCreateSupplyEntryFromPool(database.pool);

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, adminId);
        await insertHome(database.pool, homeObtainFirst, 'Obtain then end');
        await insertHome(database.pool, homeEndFirst, 'End then obtain');
        await insertHome(database.pool, homeCancelFirst, 'Cancel then end');
        await insertHome(database.pool, homeEndThenCancel, 'End then cancel');
        await insertMembership(database.pool, {
          id: roommateObtainFirst,
          homeId: homeObtainFirst,
          userId: userA,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: adminObtainFirst,
          homeId: homeObtainFirst,
          userId: adminId,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: roommateEndFirst,
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
        await insertMembership(database.pool, {
          id: roommateCancelFirst,
          homeId: homeCancelFirst,
          userId: userA,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: adminCancelFirst,
          homeId: homeCancelFirst,
          userId: adminId,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: roommateEndThenCancel,
          homeId: homeEndThenCancel,
          userId: userA,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: adminEndThenCancel,
          homeId: homeEndThenCancel,
          userId: adminId,
          role: 'ADMIN',
        });
        const roommateA = actor({
          userId: userA,
          membershipId: roommateObtainFirst,
          homeId: homeObtainFirst,
          role: 'ROOMMATE',
        });

        const obtainThenEnd = await create({
          actor: roommateA,
          homeId: homeObtainFirst,
          title: 'Obtain then end',
        });
        await claimCommand(database.pool)({
          actor: roommateA,
          homeId: homeObtainFirst,
          supplyEntryId: obtainThenEnd.id,
        });
        const obtainLocked = deferred();
        const obtainMayFinish = deferred();
        const leavePid = deferred<number>();
        const obtainRun = obtainCommand(database.pool, {
          afterLock: async () => {
            obtainLocked.resolve();
            await obtainMayFinish.promise;
          },
        })({
          actor: roommateA,
          homeId: homeObtainFirst,
          supplyEntryId: obtainThenEnd.id,
        });
        await obtainLocked.promise;
        const leaveRun = leaveCommand(database.pool, {
          capturePid: (pid) => {
            leavePid.resolve(pid);
          },
        })({
          actor: roommateA,
          homeId: homeObtainFirst,
          membershipId: roommateObtainFirst,
        });
        await waitUntil(() =>
          leavePid.promise.then((pid) => isWaitingForLock(database.pool, pid)),
        );
        obtainMayFinish.resolve();
        await obtainRun;
        await leaveRun;
        assert.equal(
          await claimReason(database.pool, obtainThenEnd.id),
          'ENTRY_OBTAINED',
        );
        assert.equal(
          await entryStatus(database.pool, obtainThenEnd.id),
          'OBTAINED',
        );

        const roommateB = actor({
          userId: userA,
          membershipId: roommateEndFirst,
          homeId: homeEndFirst,
          role: 'ROOMMATE',
        });
        const adminB = actor({
          userId: adminId,
          membershipId: adminEndFirst,
          homeId: homeEndFirst,
          role: 'ADMIN',
        });
        const endThenObtain = await create({
          actor: adminB,
          homeId: homeEndFirst,
          title: 'End then obtain',
        });
        await claimCommand(database.pool)({
          actor: adminB,
          homeId: homeEndFirst,
          supplyEntryId: endThenObtain.id,
        });
        const leaveLocked = deferred();
        const leaveMayFinish = deferred();
        const obtainPid = deferred<number>();
        const leaveFirst = leaveCommand(database.pool, {
          afterLock: async () => {
            leaveLocked.resolve();
            await leaveMayFinish.promise;
          },
        })({
          actor: roommateB,
          homeId: homeEndFirst,
          membershipId: roommateEndFirst,
        });
        await leaveLocked.promise;
        const laterObtain = observe(
          obtainCommand(database.pool, {
            capturePid: (pid) => {
              obtainPid.resolve(pid);
            },
          })({
            actor: roommateB,
            homeId: homeEndFirst,
            supplyEntryId: endThenObtain.id,
          }),
        );
        await waitUntil(() =>
          obtainPid.promise.then((pid) => isWaitingForLock(database.pool, pid)),
        );
        leaveMayFinish.resolve();
        await leaveFirst;
        const stale = await laterObtain;
        assert.equal(stale.status, 'rejected');
        assert.ok(stale.reason instanceof ConcealedNotFoundError);
        const otherActor = await obtainCommand(database.pool)({
          actor: adminB,
          homeId: homeEndFirst,
          supplyEntryId: endThenObtain.id,
        });
        assert.equal(otherActor.status, 'OBTAINED');

        const roommateC = actor({
          userId: userA,
          membershipId: roommateCancelFirst,
          homeId: homeCancelFirst,
          role: 'ROOMMATE',
        });
        const adminC = actor({
          userId: adminId,
          membershipId: adminCancelFirst,
          homeId: homeCancelFirst,
          role: 'ADMIN',
        });
        const cancelThenEnd = await create({
          actor: adminC,
          homeId: homeCancelFirst,
          title: 'Cancel then end',
        });
        await claimCommand(database.pool)({
          actor: roommateC,
          homeId: homeCancelFirst,
          supplyEntryId: cancelThenEnd.id,
        });
        const cancelLocked = deferred();
        const cancelMayFinish = deferred();
        const leave2Pid = deferred<number>();
        const cancelRun = cancelCommand(database.pool, {
          afterLock: async () => {
            cancelLocked.resolve();
            await cancelMayFinish.promise;
          },
        })({
          actor: adminC,
          homeId: homeCancelFirst,
          supplyEntryId: cancelThenEnd.id,
        });
        await cancelLocked.promise;
        const leave2 = leaveCommand(database.pool, {
          capturePid: (pid) => {
            leave2Pid.resolve(pid);
          },
        })({
          actor: roommateC,
          homeId: homeCancelFirst,
          membershipId: roommateCancelFirst,
        });
        await waitUntil(() =>
          leave2Pid.promise.then((pid) => isWaitingForLock(database.pool, pid)),
        );
        cancelMayFinish.resolve();
        await cancelRun;
        await leave2;
        assert.equal(
          await claimReason(database.pool, cancelThenEnd.id),
          'ENTRY_CANCELED',
        );

        const roommateD = actor({
          userId: userA,
          membershipId: roommateEndThenCancel,
          homeId: homeEndThenCancel,
          role: 'ROOMMATE',
        });
        const adminD = actor({
          userId: adminId,
          membershipId: adminEndThenCancel,
          homeId: homeEndThenCancel,
          role: 'ADMIN',
        });
        const endThenCancel = await create({
          actor: adminD,
          homeId: homeEndThenCancel,
          title: 'End then cancel',
        });
        const leave3Locked = deferred();
        const leave3MayFinish = deferred();
        const cancelPid = deferred<number>();
        const leave3 = leaveCommand(database.pool, {
          afterLock: async () => {
            leave3Locked.resolve();
            await leave3MayFinish.promise;
          },
        })({
          actor: roommateD,
          homeId: homeEndThenCancel,
          membershipId: roommateEndThenCancel,
        });
        await leave3Locked.promise;
        const laterCancel = observe(
          cancelCommand(database.pool, {
            capturePid: (pid) => {
              cancelPid.resolve(pid);
            },
          })({
            actor: roommateD,
            homeId: homeEndThenCancel,
            supplyEntryId: endThenCancel.id,
          }),
        );
        await waitUntil(() =>
          cancelPid.promise.then((pid) => isWaitingForLock(database.pool, pid)),
        );
        leave3MayFinish.resolve();
        await leave3;
        const staleCancel = await laterCancel;
        assert.equal(staleCancel.status, 'rejected');
        assert.ok(staleCancel.reason instanceof ConcealedNotFoundError);
        const otherCancel = await cancelCommand(database.pool)({
          actor: adminD,
          homeId: homeEndThenCancel,
          supplyEntryId: endThenCancel.id,
        });
        assert.equal(otherCancel.status, 'CANCELED');
      } finally {
        await cleanup(database.pool, {
          homeIds: [
            homeObtainFirst,
            homeEndFirst,
            homeCancelFirst,
            homeEndThenCancel,
          ],
          userIds: [userA, adminId],
        });
        await database.close();
      }
    },
  );

  void it(
    'obtain/cancel vs archive keep Home-first serialization',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userId = randomUUID();
      const homeObtainFirst = createUuidV7();
      const homeArchiveFirst = createUuidV7();
      const homeCancelFirst = createUuidV7();
      const homeArchiveThenCancel = createUuidV7();
      const membershipObtainFirst = createUuidV7();
      const membershipArchiveFirst = createUuidV7();
      const membershipCancelFirst = createUuidV7();
      const membershipArchiveThenCancel = createUuidV7();
      const create = createCreateSupplyEntryFromPool(database.pool);

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, homeObtainFirst, 'Obtain then archive');
        await insertHome(
          database.pool,
          homeArchiveFirst,
          'Archive then obtain',
        );
        await insertHome(database.pool, homeCancelFirst, 'Cancel then archive');
        await insertHome(
          database.pool,
          homeArchiveThenCancel,
          'Archive then cancel',
        );
        await insertMembership(database.pool, {
          id: membershipObtainFirst,
          homeId: homeObtainFirst,
          userId,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipArchiveFirst,
          homeId: homeArchiveFirst,
          userId,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipCancelFirst,
          homeId: homeCancelFirst,
          userId,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipArchiveThenCancel,
          homeId: homeArchiveThenCancel,
          userId,
          role: 'ADMIN',
        });

        const adminA = actor({
          userId,
          membershipId: membershipObtainFirst,
          homeId: homeObtainFirst,
          role: 'ADMIN',
        });
        const entryA = await create({
          actor: adminA,
          homeId: homeObtainFirst,
          title: 'Obtain first',
        });
        await claimCommand(database.pool)({
          actor: adminA,
          homeId: homeObtainFirst,
          supplyEntryId: entryA.id,
        });
        const obtainLocked = deferred();
        const obtainMayFinish = deferred();
        const archivePid = deferred<number>();
        const obtainRun = obtainCommand(database.pool, {
          afterLock: async () => {
            obtainLocked.resolve();
            await obtainMayFinish.promise;
          },
        })({
          actor: adminA,
          homeId: homeObtainFirst,
          supplyEntryId: entryA.id,
        });
        await obtainLocked.promise;
        const archiveRun = archiveCommand(database.pool, {
          capturePid: (pid) => {
            archivePid.resolve(pid);
          },
        })({
          homeId: homeObtainFirst,
          actor: adminA,
        });
        await waitUntil(() =>
          archivePid.promise.then((pid) =>
            isWaitingForLock(database.pool, pid),
          ),
        );
        obtainMayFinish.resolve();
        await obtainRun;
        await archiveRun;
        assert.equal(await entryStatus(database.pool, entryA.id), 'OBTAINED');
        assert.equal(
          await claimReason(database.pool, entryA.id),
          'ENTRY_OBTAINED',
        );

        const adminB = actor({
          userId,
          membershipId: membershipArchiveFirst,
          homeId: homeArchiveFirst,
          role: 'ADMIN',
        });
        const entryB = await create({
          actor: adminB,
          homeId: homeArchiveFirst,
          title: 'Archive first',
        });
        const archiveLocked = deferred();
        const archiveMayFinish = deferred();
        const obtainPid = deferred<number>();
        const archiveFirst = archiveCommand(database.pool, {
          afterLock: async () => {
            archiveLocked.resolve();
            await archiveMayFinish.promise;
          },
        })({
          homeId: homeArchiveFirst,
          actor: adminB,
        });
        await archiveLocked.promise;
        const laterObtain = observe(
          obtainCommand(database.pool, {
            capturePid: (pid) => {
              obtainPid.resolve(pid);
            },
          })({
            actor: adminB,
            homeId: homeArchiveFirst,
            supplyEntryId: entryB.id,
          }),
        );
        await waitUntil(() =>
          obtainPid.promise.then((pid) => isWaitingForLock(database.pool, pid)),
        );
        archiveMayFinish.resolve();
        await archiveFirst;
        const later = await laterObtain;
        assert.equal(later.status, 'rejected');
        assert.ok(later.reason instanceof ConcealedNotFoundError);
        assert.equal(await entryStatus(database.pool, entryB.id), 'OPEN');

        const adminC = actor({
          userId,
          membershipId: membershipCancelFirst,
          homeId: homeCancelFirst,
          role: 'ADMIN',
        });
        const entryC = await create({
          actor: adminC,
          homeId: homeCancelFirst,
          title: 'Cancel first',
        });
        const cancelLocked = deferred();
        const cancelMayFinish = deferred();
        const archive2Pid = deferred<number>();
        const cancelRun = cancelCommand(database.pool, {
          afterLock: async () => {
            cancelLocked.resolve();
            await cancelMayFinish.promise;
          },
        })({
          actor: adminC,
          homeId: homeCancelFirst,
          supplyEntryId: entryC.id,
        });
        await cancelLocked.promise;
        const archive2 = archiveCommand(database.pool, {
          capturePid: (pid) => {
            archive2Pid.resolve(pid);
          },
        })({
          homeId: homeCancelFirst,
          actor: adminC,
        });
        await waitUntil(() =>
          archive2Pid.promise.then((pid) =>
            isWaitingForLock(database.pool, pid),
          ),
        );
        cancelMayFinish.resolve();
        await cancelRun;
        await archive2;
        assert.equal(await entryStatus(database.pool, entryC.id), 'CANCELED');

        const adminD = actor({
          userId,
          membershipId: membershipArchiveThenCancel,
          homeId: homeArchiveThenCancel,
          role: 'ADMIN',
        });
        const entryD = await create({
          actor: adminD,
          homeId: homeArchiveThenCancel,
          title: 'Cancel after archive',
        });
        const archive3Locked = deferred();
        const archive3MayFinish = deferred();
        const cancelPid = deferred<number>();
        const archiveThenCancel = archiveCommand(database.pool, {
          afterLock: async () => {
            archive3Locked.resolve();
            await archive3MayFinish.promise;
          },
        })({
          homeId: homeArchiveThenCancel,
          actor: adminD,
        });
        await archive3Locked.promise;
        const laterCancel = observe(
          cancelCommand(database.pool, {
            capturePid: (pid) => {
              cancelPid.resolve(pid);
            },
          })({
            actor: adminD,
            homeId: homeArchiveThenCancel,
            supplyEntryId: entryD.id,
          }),
        );
        await waitUntil(() =>
          cancelPid.promise.then((pid) => isWaitingForLock(database.pool, pid)),
        );
        archive3MayFinish.resolve();
        await archiveThenCancel;
        const canceledLater = await laterCancel;
        assert.equal(canceledLater.status, 'rejected');
        assert.ok(canceledLater.reason instanceof ConcealedNotFoundError);
        assert.equal(await entryStatus(database.pool, entryD.id), 'OPEN');
      } finally {
        await cleanup(database.pool, {
          homeIds: [
            homeObtainFirst,
            homeArchiveFirst,
            homeCancelFirst,
            homeArchiveThenCancel,
          ],
          userIds: [userId],
        });
        await database.close();
      }
    },
  );

  void it(
    'terminalizes distinct SupplyEntries without deadlock',
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
        await insertHome(database.pool, homeId, 'Distinct terminals');
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
        const first = await create({
          actor: roommateA,
          homeId,
          title: 'Entry A',
        });
        const second = await create({
          actor: roommateB,
          homeId,
          title: 'Entry B',
        });
        const [obtained, canceled] = await Promise.all([
          obtainCommand(database.pool)({
            actor: roommateA,
            homeId,
            supplyEntryId: first.id,
          }),
          cancelCommand(database.pool)({
            actor: roommateB,
            homeId,
            supplyEntryId: second.id,
          }),
        ]);
        assert.equal(obtained.status, 'OBTAINED');
        assert.equal(canceled.status, 'CANCELED');
        assert.equal(await entryStatus(database.pool, first.id), 'OBTAINED');
        assert.equal(await entryStatus(database.pool, second.id), 'CANCELED');
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userA, userB],
        });
        await database.close();
      }
    },
  );
});
