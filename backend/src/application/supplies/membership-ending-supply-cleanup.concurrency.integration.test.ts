import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createHomeArchiveWriter } from '../../domains/homes/archive-home.js';
import { lockHomeStructure } from '../../domains/homes/lock-home-structure.js';
import { createMembershipEndingWriter } from '../../domains/memberships/update-active-membership-ended-at.js';
import {
  createSupplyRepository,
  type NewSupplyClaim,
  type NewSupplyEntry,
  type SupplyRepository,
} from '../../domains/supplies/repository.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import type { AppConfig } from '../../platform/config/types.js';
import { createOutboxWriter } from '../../platform/events/outbox-writer.js';
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
import type { Clock } from '../../platform/time/clock.js';
import { createArchiveFinalMemberHome } from '../home-administration/archive-final-member-home.js';
import {
  createApplyMembershipEndingWithinHomeStructureFromPool,
  createEndMembershipWithinHomeStructure,
} from '../home-administration/end-membership-within-home-structure.js';
import { createLeaveMembership } from '../home-administration/leave-membership.js';
import { createRemoveMembership } from '../home-administration/remove-membership.js';
import { createMembershipEndingSupplyCleanupFromPool } from './membership-ending-supply-cleanup.js';
import { createMembershipEndingTaskCleanupFromPool } from '../tasks/membership-ending-task-cleanup.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const CREATED = new Date('2026-09-12T17:00:00.000Z');
const CLAIMED_AT = new Date('2026-09-12T17:15:00.000Z');
const FIRST_END = new Date('2026-09-12T18:00:00.000Z');
const SECOND_END = new Date('2026-09-12T18:30:00.000Z');
const ARCHIVE_AT = new Date('2026-09-12T18:45:00.000Z');
const ENDING_AT = new Date('2026-09-12T18:00:00.000Z');

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

function openEntry(input: {
  id: string;
  homeId: string;
  createdByMembershipId: string;
  title?: string;
}): NewSupplyEntry {
  return {
    id: input.id,
    homeId: input.homeId,
    title: input.title ?? 'Paper towels',
    status: 'OPEN',
    createdByMembershipId: input.createdByMembershipId,
    obtainedAt: null,
    canceledAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
  };
}

function activeClaim(input: {
  id: string;
  homeId: string;
  supplyEntryId: string;
  claimantMembershipId: string;
}): NewSupplyClaim {
  return {
    id: input.id,
    homeId: input.homeId,
    supplyEntryId: input.supplyEntryId,
    claimantMembershipId: input.claimantMembershipId,
    claimedAt: CLAIMED_AT,
    releasedAt: null,
    releaseReason: null,
    createdAt: CLAIMED_AT,
    updatedAt: CLAIMED_AT,
  };
}

async function insertEntry(
  supplies: SupplyRepository,
  pool: Pool,
  entry: NewSupplyEntry,
): Promise<void> {
  await runInReadCommittedTransaction(pool, async (tx) => {
    await supplies.insertSupplyEntry(tx, entry);
  });
}

async function insertClaim(
  supplies: SupplyRepository,
  pool: Pool,
  claim: NewSupplyClaim,
): Promise<void> {
  await runInReadCommittedTransaction(pool, async (tx) => {
    await supplies.insertSupplyClaim(tx, claim);
  });
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

function endingSeam(pool: Pool) {
  return createEndMembershipWithinHomeStructure({
    taskCleanup: createMembershipEndingTaskCleanupFromPool(pool),
    supplyCleanup: createMembershipEndingSupplyCleanupFromPool(pool),
    membershipEnding: createMembershipEndingWriter(),
    outbox: createOutboxWriter(),
    ids: { next: () => createUuidV7() },
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
    clock: options.clock ?? { now: () => ENDING_AT },
    endMembership: endingSeam(pool),
  });
}

function removeCommand(
  pool: Pool,
  options: {
    afterLock?: () => Promise<void>;
    capturePid?: (pid: number) => void;
    clock?: Clock;
  } = {},
) {
  return createRemoveMembership({
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
    clock: options.clock ?? { now: () => ENDING_AT },
    endMembership: endingSeam(pool),
  });
}

async function claimState(
  pool: Pool,
  claimId: string,
): Promise<{
  claimantMembershipId: string;
  releasedAt: Date | null;
  releaseReason: string | null;
  updatedAt: Date;
}> {
  const result = await pool.query<{
    claimant_membership_id: string;
    released_at: Date | null;
    release_reason: string | null;
    updated_at: Date;
  }>(
    `SELECT claimant_membership_id, released_at, release_reason, updated_at
     FROM supply_claims WHERE id = $1`,
    [claimId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`claim ${claimId} was missing`);
  }
  return {
    claimantMembershipId: row.claimant_membership_id,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
    updatedAt: row.updated_at,
  };
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

async function endedEvents(
  pool: Pool,
  homeId: string,
): Promise<
  readonly { membershipId: string; cause: string; occurredAt: Date }[]
> {
  const result = await pool.query<{
    membership_id: string;
    cause: string;
    occurred_at: Date;
  }>(
    `SELECT payload->>'membershipId' AS membership_id,
            payload->>'cause' AS cause,
            occurred_at
     FROM outbox_events
     WHERE home_id = $1 AND event_type = 'membership.ended.v1'
     ORDER BY occurred_at, payload->>'membershipId'`,
    [homeId],
  );
  return result.rows.map((row) => ({
    membershipId: row.membership_id,
    cause: row.cause,
    occurredAt: row.occurred_at,
  }));
}

void describe('Membership-ending Supply cleanup concurrency PostgreSQL', () => {
  void it(
    'claim insert winning before Membership ending is released by cleanup',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const supplies = createSupplyRepository(database.pool);
      const adminId = randomUUID();
      const leavingId = randomUUID();
      const homeId = randomUUID();
      const adminMembership = randomUUID();
      const leavingMembership = randomUUID();
      const entryId = createUuidV7();
      const claimId = createUuidV7();
      const claimLocked = deferred();
      const claimMayFinish = deferred();
      const leavePid = deferred<number>();
      let leaveFinished = false;

      try {
        await insertUser(database.pool, adminId);
        await insertUser(database.pool, leavingId);
        await insertHome(database.pool, homeId, 'Claim wins ending');
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
        await insertEntry(
          supplies,
          database.pool,
          openEntry({
            id: entryId,
            homeId,
            createdByMembershipId: adminMembership,
          }),
        );

        const claimRun = runInReadCommittedTransaction(
          database.pool,
          async (tx) => {
            await lockHomeStructure(tx, {
              homeId,
              actor: actor({
                userId: leavingId,
                membershipId: leavingMembership,
                homeId,
                role: 'ROOMMATE',
              }),
            });
            await supplies.insertSupplyClaim(
              tx,
              activeClaim({
                id: claimId,
                homeId,
                supplyEntryId: entryId,
                claimantMembershipId: leavingMembership,
              }),
            );
            claimLocked.resolve();
            await claimMayFinish.promise;
          },
        );

        await claimLocked.promise;
        const leaveRun = leaveCommand(database.pool, {
          capturePid: (pid) => {
            leavePid.resolve(pid);
          },
          clock: { now: () => ENDING_AT },
        })({
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

        claimMayFinish.resolve();
        await claimRun;
        await leaveRun;

        const released = await claimState(database.pool, claimId);
        assert.equal(released.releaseReason, 'MEMBERSHIP_ENDED');
        assert.deepEqual(released.releasedAt, ENDING_AT);
        assert.deepEqual(released.updatedAt, ENDING_AT);
        assert.equal(released.claimantMembershipId, leavingMembership);
        assert.deepEqual(
          await membershipEndedAt(database.pool, leavingMembership),
          ENDING_AT,
        );
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
    'Membership ending winning first leaves structural cleanup correct; future claim creation must revalidate the ended tenure',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const supplies = createSupplyRepository(database.pool);
      const adminId = randomUUID();
      const leavingId = randomUUID();
      const homeId = randomUUID();
      const adminMembership = randomUUID();
      const leavingMembership = randomUUID();
      const existingEntry = createUuidV7();
      const laterEntry = createUuidV7();
      const existingClaim = createUuidV7();
      const persistenceOnlyClaim = createUuidV7();
      const leaveLocked = deferred();
      const leaveMayFinish = deferred();
      const claimPid = deferred<number>();

      try {
        await insertUser(database.pool, adminId);
        await insertUser(database.pool, leavingId);
        await insertHome(database.pool, homeId, 'Ending wins claim');
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
        await insertEntry(
          supplies,
          database.pool,
          openEntry({
            id: existingEntry,
            homeId,
            createdByMembershipId: adminMembership,
            title: 'Existing claim',
          }),
        );
        await insertEntry(
          supplies,
          database.pool,
          openEntry({
            id: laterEntry,
            homeId,
            createdByMembershipId: adminMembership,
            title: 'Later persistence insert',
          }),
        );
        await insertClaim(
          supplies,
          database.pool,
          activeClaim({
            id: existingClaim,
            homeId,
            supplyEntryId: existingEntry,
            claimantMembershipId: leavingMembership,
          }),
        );

        const leaveRun = leaveCommand(database.pool, {
          afterLock: async () => {
            leaveLocked.resolve();
            await leaveMayFinish.promise;
          },
          clock: { now: () => ENDING_AT },
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

        const laterClaimRun = runInReadCommittedTransaction(
          database.pool,
          async (tx) => {
            claimPid.resolve(await backendPid(tx));
            await lockHomeStructure(tx, {
              homeId,
              actor: actor({
                userId: adminId,
                membershipId: adminMembership,
                homeId,
                role: 'ADMIN',
              }),
            });
            return supplies.insertSupplyClaim(
              tx,
              activeClaim({
                id: persistenceOnlyClaim,
                homeId,
                supplyEntryId: laterEntry,
                claimantMembershipId: leavingMembership,
              }),
            );
          },
        );
        const pid = await claimPid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));

        leaveMayFinish.resolve();
        await leaveRun;
        await laterClaimRun;

        const released = await claimState(database.pool, existingClaim);
        assert.equal(released.releaseReason, 'MEMBERSHIP_ENDED');
        assert.deepEqual(released.releasedAt, ENDING_AT);
        assert.deepEqual(
          await membershipEndedAt(database.pool, leavingMembership),
          ENDING_AT,
        );
        // Persistence-only insertSupplyClaim can still attribute an ended
        // tenure. That is not an M4.1 bug. Future M4 claim creation must
        // revalidate the exact active Membership under the same Home lock.
        const persistenceOnly = await claimState(
          database.pool,
          persistenceOnlyClaim,
        );
        assert.equal(persistenceOnly.releasedAt, null);
        assert.equal(persistenceOnly.claimantMembershipId, leavingMembership);
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
    'two Membership endings in the same Home release only their own claims without deadlock or timestamp mixing',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const supplies = createSupplyRepository(database.pool);
      const adminId = randomUUID();
      const firstId = randomUUID();
      const secondId = randomUUID();
      const homeId = randomUUID();
      const adminMembership = randomUUID();
      const firstMembership = randomUUID();
      const secondMembership = randomUUID();
      const firstEntry = createUuidV7();
      const secondEntry = createUuidV7();
      const firstClaim = createUuidV7();
      const secondClaim = createUuidV7();

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
        await insertEntry(
          supplies,
          database.pool,
          openEntry({
            id: firstEntry,
            homeId,
            createdByMembershipId: adminMembership,
            title: 'First',
          }),
        );
        await insertEntry(
          supplies,
          database.pool,
          openEntry({
            id: secondEntry,
            homeId,
            createdByMembershipId: adminMembership,
            title: 'Second',
          }),
        );
        await insertClaim(
          supplies,
          database.pool,
          activeClaim({
            id: firstClaim,
            homeId,
            supplyEntryId: firstEntry,
            claimantMembershipId: firstMembership,
          }),
        );
        await insertClaim(
          supplies,
          database.pool,
          activeClaim({
            id: secondClaim,
            homeId,
            supplyEntryId: secondEntry,
            claimantMembershipId: secondMembership,
          }),
        );

        const settled = await Promise.allSettled([
          leaveCommand(database.pool, {
            clock: { now: () => FIRST_END },
          })({
            actor: actor({
              userId: firstId,
              membershipId: firstMembership,
              homeId,
              role: 'ROOMMATE',
            }),
            homeId,
            membershipId: firstMembership,
          }),
          leaveCommand(database.pool, {
            clock: { now: () => SECOND_END },
          })({
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

        const first = await claimState(database.pool, firstClaim);
        const second = await claimState(database.pool, secondClaim);
        const firstEnded = await membershipEndedAt(
          database.pool,
          firstMembership,
        );
        const secondEnded = await membershipEndedAt(
          database.pool,
          secondMembership,
        );
        assert.equal(first.releaseReason, 'MEMBERSHIP_ENDED');
        assert.equal(second.releaseReason, 'MEMBERSHIP_ENDED');
        assert.equal(first.claimantMembershipId, firstMembership);
        assert.equal(second.claimantMembershipId, secondMembership);
        assert.deepEqual(first.releasedAt, firstEnded);
        assert.deepEqual(first.updatedAt, firstEnded);
        assert.deepEqual(second.releasedAt, secondEnded);
        assert.deepEqual(second.updatedAt, secondEnded);
        assert.notEqual(firstEnded?.getTime(), secondEnded?.getTime());
        assert.ok(
          (firstEnded?.getTime() === FIRST_END.getTime() &&
            secondEnded?.getTime() === SECOND_END.getTime()) ||
            (firstEnded?.getTime() === SECOND_END.getTime() &&
              secondEnded?.getTime() === FIRST_END.getTime()),
        );
        assert.notEqual(
          first.releasedAt?.getTime(),
          second.releasedAt?.getTime(),
        );
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
    'leave versus remove of the same Membership runs cleanup once',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const supplies = createSupplyRepository(database.pool);
      const adminId = randomUUID();
      const leavingId = randomUUID();
      const homeId = randomUUID();
      const adminMembership = randomUUID();
      const leavingMembership = randomUUID();
      const entryId = createUuidV7();
      const claimId = createUuidV7();

      try {
        await insertUser(database.pool, adminId);
        await insertUser(database.pool, leavingId);
        await insertHome(database.pool, homeId, 'Leave versus remove');
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
        await insertEntry(
          supplies,
          database.pool,
          openEntry({
            id: entryId,
            homeId,
            createdByMembershipId: adminMembership,
          }),
        );
        await insertClaim(
          supplies,
          database.pool,
          activeClaim({
            id: claimId,
            homeId,
            supplyEntryId: entryId,
            claimantMembershipId: leavingMembership,
          }),
        );

        const settled = await Promise.allSettled([
          leaveCommand(database.pool)({
            actor: actor({
              userId: leavingId,
              membershipId: leavingMembership,
              homeId,
              role: 'ROOMMATE',
            }),
            homeId,
            membershipId: leavingMembership,
          }),
          removeCommand(database.pool)({
            actor: actor({
              userId: adminId,
              membershipId: adminMembership,
              homeId,
              role: 'ADMIN',
            }),
            homeId,
            membershipId: leavingMembership,
          }),
        ]);
        assert.equal(
          settled.filter((result) => result.status === 'fulfilled').length,
          1,
        );
        assert.equal(
          settled.filter((result) => result.status === 'rejected').length,
          1,
        );

        const released = await claimState(database.pool, claimId);
        const events = await endedEvents(database.pool, homeId);
        assert.equal(released.releaseReason, 'MEMBERSHIP_ENDED');
        assert.deepEqual(released.releasedAt, ENDING_AT);
        assert.deepEqual(released.updatedAt, ENDING_AT);
        assert.equal(released.claimantMembershipId, leavingMembership);
        assert.deepEqual(
          await membershipEndedAt(database.pool, leavingMembership),
          ENDING_AT,
        );
        assert.equal(events.length, 1);
        assert.equal(events[0]?.membershipId, leavingMembership);
        assert.ok(
          events[0]?.cause === 'VOLUNTARY_LEAVE' ||
            events[0]?.cause === 'ADMIN_REMOVAL',
        );
        assert.deepEqual(events[0]?.occurredAt, ENDING_AT);
        assert.equal(
          await membershipEndedAt(database.pool, adminMembership),
          null,
        );
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
    'Home archive after an in-flight claim insert uses one archive timestamp',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const supplies = createSupplyRepository(database.pool);
      const adminId = randomUUID();
      const homeId = randomUUID();
      const adminMembership = randomUUID();
      const entryId = createUuidV7();
      const claimId = createUuidV7();
      const archiveReachedLock = deferred();
      const archiveMayLock = deferred();

      try {
        await insertUser(database.pool, adminId);
        await insertHome(database.pool, homeId, 'Archive after claim');
        await insertMembership(database.pool, {
          id: adminMembership,
          homeId,
          userId: adminId,
          role: 'ADMIN',
        });
        await insertEntry(
          supplies,
          database.pool,
          openEntry({
            id: entryId,
            homeId,
            createdByMembershipId: adminMembership,
          }),
        );

        const archiveRun = createArchiveFinalMemberHome({
          runTransaction: (work) =>
            runInReadCommittedTransaction(database.pool, work),
          lockHomeStructure: async (tx, input) => {
            archiveReachedLock.resolve();
            await archiveMayLock.promise;
            return lockHomeStructure(tx, input);
          },
          clock: { now: () => ARCHIVE_AT },
          invitationRevoker: {
            lockPendingForHomeArchive() {
              return Promise.resolve();
            },
            revokeLockedPendingForHomeArchive() {
              return Promise.resolve();
            },
          },
          applyMembershipEnding:
            createApplyMembershipEndingWithinHomeStructureFromPool(
              database.pool,
            ),
          homeArchive: createHomeArchiveWriter(),
          outbox: createOutboxWriter(),
          ids: { next: () => createUuidV7() },
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
        await insertClaim(
          supplies,
          database.pool,
          activeClaim({
            id: claimId,
            homeId,
            supplyEntryId: entryId,
            claimantMembershipId: adminMembership,
          }),
        );
        archiveMayLock.resolve();
        await archiveRun;

        const released = await claimState(database.pool, claimId);
        const endedAt = await membershipEndedAt(database.pool, adminMembership);
        const home = await database.pool.query<{ archived_at: Date | null }>(
          'SELECT archived_at FROM homes WHERE id = $1',
          [homeId],
        );
        const events = await database.pool.query<{
          event_type: string;
          occurred_at: Date;
        }>(
          `SELECT event_type, occurred_at FROM outbox_events
           WHERE home_id = $1 ORDER BY event_type`,
          [homeId],
        );
        assert.equal(released.releaseReason, 'MEMBERSHIP_ENDED');
        assert.deepEqual(released.releasedAt, ARCHIVE_AT);
        assert.deepEqual(released.updatedAt, ARCHIVE_AT);
        assert.equal(released.claimantMembershipId, adminMembership);
        assert.deepEqual(endedAt, ARCHIVE_AT);
        assert.deepEqual(home.rows[0]?.archived_at, ARCHIVE_AT);
        assert.deepEqual(
          events.rows.map((row) => row.event_type),
          ['home.archived.v1', 'membership.ended.v1'],
        );
        assert.deepEqual(events.rows[0]?.occurred_at, ARCHIVE_AT);
        assert.deepEqual(events.rows[1]?.occurred_at, ARCHIVE_AT);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [adminId],
        });
        await database.close();
      }
    },
  );
});
