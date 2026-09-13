import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { lockHomeAndExactMemberships } from '../../domains/homes/lock-home-and-exact-memberships.js';
import { SupplyNotOpenError } from '../../domains/supplies/errors.js';
import {
  createSupplyRepository,
  type NewSupplyEntry,
} from '../../domains/supplies/repository.js';
import { toSupplyEntryDto } from '../../domains/supplies/supply-entry-dto.js';
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
import { createCancelSupplyEntry } from './cancel-supply-entry.js';
import { createClaimSupplyEntryFromPool } from './claim-supply-entry.js';
import { createCreateSupplyEntryFromPool } from './create-supply-entry.js';
import { createListHomeSuppliesFromPool } from './list-home-supplies.js';
import { createMarkSupplyEntryObtained } from './mark-supply-entry-obtained.js';
import { createMembershipEndingSupplyCleanupFromPool } from './membership-ending-supply-cleanup.js';
import { createReleaseSupplyClaimFromPool } from './release-supply-claim.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const OCCURRED = new Date('2026-12-31T20:00:00.000Z');
const PRIOR = new Date('2026-09-13T17:00:00.000Z');

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

function actor(
  homeId: string,
  membershipId: string,
  userId: string,
  role: ActiveHomeActor['role'] = 'ROOMMATE',
): ActiveHomeActor {
  return { userId, membershipId, homeId, role };
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
    await pool.query('DELETE FROM supply_claims WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query('DELETE FROM supply_entries WHERE home_id = ANY($1)', [
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

async function insertEntry(pool: Pool, entry: NewSupplyEntry): Promise<void> {
  const supplies = createSupplyRepository(pool);
  await runInReadCommittedTransaction(pool, async (tx) => {
    await supplies.insertSupplyEntry(tx, entry);
  });
}

async function claimRow(
  pool: Pool,
  claimId: string,
): Promise<{
  claimantMembershipId: string;
  claimedAt: Date;
  createdAt: Date;
  releasedAt: Date | null;
  releaseReason: string | null;
  updatedAt: Date;
}> {
  const result = await pool.query<{
    claimant_membership_id: string;
    claimed_at: Date;
    created_at: Date;
    released_at: Date | null;
    release_reason: string | null;
    updated_at: Date;
  }>(
    `SELECT claimant_membership_id, claimed_at, created_at, released_at,
            release_reason, updated_at
     FROM supply_claims WHERE id = $1`,
    [claimId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('claim missing');
  }
  return {
    claimantMembershipId: row.claimant_membership_id,
    claimedAt: row.claimed_at,
    createdAt: row.created_at,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
    updatedAt: row.updated_at,
  };
}

async function entryRow(
  pool: Pool,
  entryId: string,
): Promise<{
  status: string;
  createdByMembershipId: string;
  obtainedAt: Date | null;
  canceledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}> {
  const result = await pool.query<{
    status: string;
    created_by_membership_id: string;
    obtained_at: Date | null;
    canceled_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT status, created_by_membership_id, obtained_at, canceled_at,
            created_at, updated_at
     FROM supply_entries WHERE id = $1`,
    [entryId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('entry missing');
  }
  return {
    status: row.status,
    createdByMembershipId: row.created_by_membership_id,
    obtainedAt: row.obtained_at,
    canceledAt: row.canceled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function supplyOutboxCount(
  pool: Pool,
  homeIds: string[],
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM outbox_events
     WHERE home_id = ANY($1) AND event_type LIKE 'supply.%'`,
    [homeIds],
  );
  return Number(result.rows[0]?.count ?? '0');
}

void describe('SupplyEntry terminalization PostgreSQL', () => {
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
    'covers obtain/cancel lifecycle, attribution, concealment, clock, and no outbox',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const create = createCreateSupplyEntryFromPool(database.pool);
      const claim = createClaimSupplyEntryFromPool(database.pool);
      const release = createReleaseSupplyClaimFromPool(database.pool);
      const list = createListHomeSuppliesFromPool(database.pool);
      const supplies = createSupplyRepository(database.pool);
      const userA = randomUUID();
      const userB = randomUUID();
      const homeA = createUuidV7();
      const homeB = createUuidV7();
      const membershipA = createUuidV7();
      const membershipAdmin = createUuidV7();
      const endedMembership = createUuidV7();
      const otherMembership = createUuidV7();
      const userIds = [userA, userB];
      const homeIds = [homeA, homeB];

      function countingObtain(clock: { calls: number }) {
        return createMarkSupplyEntryObtained({
          runTransaction: (work) =>
            runInReadCommittedTransaction(database.pool, work),
          lockHomeAndExactMemberships,
          supplies,
          clock: {
            now() {
              clock.calls += 1;
              return OCCURRED;
            },
          },
        });
      }

      function countingCancel(clock: { calls: number }) {
        return createCancelSupplyEntry({
          runTransaction: (work) =>
            runInReadCommittedTransaction(database.pool, work),
          lockHomeAndExactMemberships,
          supplies,
          clock: {
            now() {
              clock.calls += 1;
              return OCCURRED;
            },
          },
        });
      }

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
          id: membershipAdmin,
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

        const actions = [
          {
            name: 'obtain',
            reason: 'ENTRY_OBTAINED' as const,
            status: 'OBTAINED' as const,
            createCommand: countingObtain,
          },
          {
            name: 'cancel',
            reason: 'ENTRY_CANCELED' as const,
            status: 'CANCELED' as const,
            createCommand: countingCancel,
          },
        ] as const;

        for (const action of actions) {
          const claimedEntry = await create({
            actor: actor(homeA, membershipA, userA),
            homeId: homeA,
            title: `${action.name} claimed`,
          });
          const claimed = await claim({
            actor: actor(homeA, membershipAdmin, userB, 'ADMIN'),
            homeId: homeA,
            supplyEntryId: claimedEntry.id,
          });
          const clock = { calls: 0 };
          const run = action.createCommand(clock);
          const updated = await run({
            actor: actor(homeA, membershipA, userA),
            homeId: homeA,
            supplyEntryId: claimedEntry.id,
          });
          assert.equal(clock.calls, 1);
          assert.equal(updated.status, action.status);
          assert.equal(updated.createdByMembershipId, membershipA);
          assert.equal(
            updated.createdAt.getTime(),
            claimedEntry.createdAt.getTime(),
          );
          if (action.status === 'OBTAINED') {
            assert.equal(updated.obtainedAt?.getTime(), OCCURRED.getTime());
            assert.equal(updated.canceledAt, null);
          } else {
            assert.equal(updated.canceledAt?.getTime(), OCCURRED.getTime());
            assert.equal(updated.obtainedAt, null);
          }
          assert.equal(updated.updatedAt.getTime(), OCCURRED.getTime());
          const dto = toSupplyEntryDto(updated);
          assert.equal(dto.activeClaim, null);
          assert.equal(dto.status, action.status);

          const persistedClaim = await claimRow(database.pool, claimed.id);
          assert.equal(persistedClaim.releaseReason, action.reason);
          assert.equal(
            persistedClaim.releasedAt?.getTime(),
            OCCURRED.getTime(),
          );
          assert.equal(persistedClaim.updatedAt.getTime(), OCCURRED.getTime());
          assert.equal(persistedClaim.claimantMembershipId, membershipAdmin);
          assert.equal(
            persistedClaim.claimedAt.getTime(),
            claimed.claimedAt.getTime(),
          );
          assert.equal(
            persistedClaim.createdAt.getTime(),
            claimed.createdAt.getTime(),
          );

          const listed = await list({
            actor: actor(homeA, membershipA, userA),
            homeId: homeA,
          });
          assert.equal(
            listed.find((row) => row.id === claimedEntry.id)?.activeClaim,
            null,
          );

          await assert.rejects(
            () =>
              run({
                actor: actor(homeA, membershipA, userA),
                homeId: homeA,
                supplyEntryId: claimedEntry.id,
              }),
            SupplyNotOpenError,
          );
          assert.equal(clock.calls, 1);
          const afterRepeat = await claimRow(database.pool, claimed.id);
          assert.equal(afterRepeat.releaseReason, action.reason);
          assert.equal(
            afterRepeat.releasedAt?.getTime(),
            persistedClaim.releasedAt?.getTime(),
          );

          const emptyEntry = await create({
            actor: actor(homeA, membershipAdmin, userB, 'ADMIN'),
            homeId: homeA,
            title: `${action.name} empty`,
          });
          const emptyClock = { calls: 0 };
          const emptyUpdated = await action.createCommand(emptyClock)({
            actor: actor(homeA, membershipA, userA),
            homeId: homeA,
            supplyEntryId: emptyEntry.id,
          });
          assert.equal(emptyClock.calls, 1);
          assert.equal(emptyUpdated.status, action.status);
          assert.equal(emptyUpdated.createdByMembershipId, membershipAdmin);

          const oppositeEntry = await create({
            actor: actor(homeA, membershipA, userA),
            homeId: homeA,
            title: `${action.name} opposite`,
          });
          const oppositeClock = { calls: 0 };
          const firstTerminal = action.createCommand(oppositeClock);
          await firstTerminal({
            actor: actor(homeA, membershipAdmin, userB, 'ADMIN'),
            homeId: homeA,
            supplyEntryId: oppositeEntry.id,
          });
          const opposite =
            action.name === 'obtain' ? countingCancel : countingObtain;
          const oppositeCalls = { calls: 0 };
          await assert.rejects(
            () =>
              opposite(oppositeCalls)({
                actor: actor(homeA, membershipA, userA),
                homeId: homeA,
                supplyEntryId: oppositeEntry.id,
              }),
            SupplyNotOpenError,
          );
          assert.equal(oppositeCalls.calls, 0);
        }

        const foreign = await create({
          actor: actor(homeB, otherMembership, userB),
          homeId: homeB,
          title: 'Foreign',
        });
        const concealClock = { calls: 0 };
        await assert.rejects(
          () =>
            countingObtain(concealClock)({
              actor: actor(homeA, membershipA, userA),
              homeId: homeA,
              supplyEntryId: foreign.id,
            }),
          ConcealedNotFoundError,
        );
        await assert.rejects(
          () =>
            countingCancel(concealClock)({
              actor: actor(homeA, membershipA, userA),
              homeId: homeA,
              supplyEntryId: createUuidV7(),
            }),
          ConcealedNotFoundError,
        );
        await assert.rejects(
          () =>
            countingObtain(concealClock)({
              actor: actor(homeA, endedMembership, userA),
              homeId: homeA,
              supplyEntryId: foreign.id,
            }),
          ConcealedNotFoundError,
        );
        assert.equal(concealClock.calls, 0);

        await database.pool.query(
          'UPDATE memberships SET ended_at = $2 WHERE id = $1',
          [membershipA, OCCURRED],
        );
        const rejoined = createUuidV7();
        await insertMembership(database.pool, {
          id: rejoined,
          homeId: homeA,
          userId: userA,
          role: 'ROOMMATE',
        });
        const staleEntry = await create({
          actor: actor(homeA, rejoined, userA),
          homeId: homeA,
          title: 'Stale actor',
        });
        const staleClock = { calls: 0 };
        await assert.rejects(
          () =>
            countingObtain(staleClock)({
              actor: actor(homeA, membershipA, userA),
              homeId: homeA,
              supplyEntryId: staleEntry.id,
            }),
          ConcealedNotFoundError,
        );
        assert.equal(staleClock.calls, 0);
        const newTenure = await countingCancel({ calls: 0 })({
          actor: actor(homeA, rejoined, userA),
          homeId: homeA,
          supplyEntryId: staleEntry.id,
        });
        assert.equal(newTenure.status, 'CANCELED');
        assert.equal(newTenure.createdByMembershipId, rejoined);

        const cleanupEntry = await create({
          actor: actor(homeA, rejoined, userA),
          homeId: homeA,
          title: 'Cleanup after obtain',
        });
        const cleanupClaimed = await claim({
          actor: actor(homeA, rejoined, userA),
          homeId: homeA,
          supplyEntryId: cleanupEntry.id,
        });
        await countingObtain({ calls: 0 })({
          actor: actor(homeA, membershipAdmin, userB, 'ADMIN'),
          homeId: homeA,
          supplyEntryId: cleanupEntry.id,
        });
        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await createMembershipEndingSupplyCleanupFromPool(
            database.pool,
          ).handleMembershipEnded(tx, {
            homeId: homeA,
            membershipId: rejoined,
            endedAt: OCCURRED,
            cause: 'VOLUNTARY_LEAVE',
          });
        });
        assert.equal(
          (await claimRow(database.pool, cleanupClaimed.id)).releaseReason,
          'ENTRY_OBTAINED',
        );

        const endedFirst = await create({
          actor: actor(homeA, membershipAdmin, userB, 'ADMIN'),
          homeId: homeA,
          title: 'End first then cancel',
        });
        const endedClaim = await claim({
          actor: actor(homeA, rejoined, userA),
          homeId: homeA,
          supplyEntryId: endedFirst.id,
        });
        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await createMembershipEndingSupplyCleanupFromPool(
            database.pool,
          ).handleMembershipEnded(tx, {
            homeId: homeA,
            membershipId: rejoined,
            endedAt: OCCURRED,
            cause: 'VOLUNTARY_LEAVE',
          });
        });
        assert.equal(
          (await claimRow(database.pool, endedClaim.id)).releaseReason,
          'MEMBERSHIP_ENDED',
        );
        const afterEnd = await countingCancel({ calls: 0 })({
          actor: actor(homeA, membershipAdmin, userB, 'ADMIN'),
          homeId: homeA,
          supplyEntryId: endedFirst.id,
        });
        assert.equal(afterEnd.status, 'CANCELED');
        assert.equal(
          (await claimRow(database.pool, endedClaim.id)).releaseReason,
          'MEMBERSHIP_ENDED',
        );

        const releasedFirst = await create({
          actor: actor(homeA, membershipAdmin, userB, 'ADMIN'),
          homeId: homeA,
          title: 'Manual then obtain',
        });
        const releasedClaim = await claim({
          actor: actor(homeA, membershipAdmin, userB, 'ADMIN'),
          homeId: homeA,
          supplyEntryId: releasedFirst.id,
        });
        await release({
          actor: actor(homeA, membershipAdmin, userB, 'ADMIN'),
          homeId: homeA,
          supplyEntryId: releasedFirst.id,
        });
        await countingObtain({ calls: 0 })({
          actor: actor(homeA, membershipAdmin, userB, 'ADMIN'),
          homeId: homeA,
          supplyEntryId: releasedFirst.id,
        });
        assert.equal(
          (await claimRow(database.pool, releasedClaim.id)).releaseReason,
          'CLAIMANT_RELEASED',
        );

        const olderTerminal = createUuidV7();
        const newerTerminal = createUuidV7();
        const olderCreated = new Date('2026-09-10T11:00:00.000Z');
        const olderCanceled = new Date('2026-09-10T12:00:00.000Z');
        await insertEntry(database.pool, {
          id: olderTerminal,
          homeId: homeA,
          title: 'Older terminal',
          status: 'CANCELED',
          createdByMembershipId: membershipAdmin,
          obtainedAt: null,
          canceledAt: olderCanceled,
          createdAt: olderCreated,
          updatedAt: olderCanceled,
        });
        await insertEntry(database.pool, {
          id: newerTerminal,
          homeId: homeA,
          title: 'Newer terminal seed',
          status: 'OPEN',
          createdByMembershipId: membershipAdmin,
          obtainedAt: null,
          canceledAt: null,
          createdAt: olderCreated,
          updatedAt: olderCreated,
        });
        await countingObtain({ calls: 0 })({
          actor: actor(homeA, membershipAdmin, userB, 'ADMIN'),
          homeId: homeA,
          supplyEntryId: newerTerminal,
        });
        const ordered = await list({
          actor: actor(homeA, membershipAdmin, userB, 'ADMIN'),
          homeId: homeA,
        });
        const terminalIds = ordered
          .filter((row) => row.status !== 'OPEN')
          .map((row) => row.id);
        assert.ok(
          terminalIds.indexOf(newerTerminal) <
            terminalIds.indexOf(olderTerminal),
        );

        const leftoverEvents = await supplyOutboxCount(database.pool, homeIds);
        assert.equal(leftoverEvents, 0);
      } finally {
        await cleanup(database.pool, { userIds, homeIds });
        await database.close();
      }
    },
  );

  void it(
    'does not mutate a corrupted terminal entry with an active claim',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const supplies = createSupplyRepository(database.pool);
      const userId = randomUUID();
      const homeId = createUuidV7();
      const membershipId = createUuidV7();
      const entryId = createUuidV7();
      const claimId = createUuidV7();

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, { id: homeId, name: 'Corruption' });
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ROOMMATE',
        });
        await insertEntry(database.pool, {
          id: entryId,
          homeId,
          title: 'Corrupt',
          status: 'OBTAINED',
          createdByMembershipId: membershipId,
          obtainedAt: PRIOR,
          canceledAt: null,
          createdAt: PRIOR,
          updatedAt: PRIOR,
        });
        await database.pool.query(
          `INSERT INTO supply_claims (
             id, home_id, supply_entry_id, claimant_membership_id,
             claimed_at, released_at, release_reason, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, NULL, NULL, $5, $5)`,
          [claimId, homeId, entryId, membershipId, PRIOR],
        );

        let claimLocks = 0;
        await assert.rejects(
          () =>
            createMarkSupplyEntryObtained({
              runTransaction: (work) =>
                runInReadCommittedTransaction(database.pool, work),
              lockHomeAndExactMemberships,
              supplies: {
                lockSupplyEntryByHomeAndId: (tx, home, id) =>
                  supplies.lockSupplyEntryByHomeAndId(tx, home, id),
                lockActiveClaimByEntry: async (tx, home, id) => {
                  claimLocks += 1;
                  return supplies.lockActiveClaimByEntry(tx, home, id);
                },
                releaseActiveClaimForEntryTerminalization: (tx, input) =>
                  supplies.releaseActiveClaimForEntryTerminalization(tx, input),
                terminalizeSupplyEntryAsObtained: (tx, input) =>
                  supplies.terminalizeSupplyEntryAsObtained(tx, input),
              },
              clock: { now: () => OCCURRED },
            })({
              actor: actor(homeId, membershipId, userId),
              homeId,
              supplyEntryId: entryId,
            }),
          SupplyNotOpenError,
        );
        assert.equal(claimLocks, 0);
        const claim = await claimRow(database.pool, claimId);
        assert.equal(claim.releasedAt, null);
        assert.equal(claim.releaseReason, null);
        const entry = await entryRow(database.pool, entryId);
        assert.equal(entry.status, 'OBTAINED');
        assert.equal(entry.obtainedAt?.getTime(), PRIOR.getTime());
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
    'rolls back Case A: released claim then failed entry update',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const supplies = createSupplyRepository(database.pool);
      const create = createCreateSupplyEntryFromPool(database.pool);
      const claim = createClaimSupplyEntryFromPool(database.pool);
      const userId = randomUUID();
      const homeId = createUuidV7();
      const membershipId = createUuidV7();

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, { id: homeId, name: 'Rollback A' });
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ROOMMATE',
        });
        const created = await create({
          actor: actor(homeId, membershipId, userId),
          homeId,
          title: 'Case A',
        });
        const claimed = await claim({
          actor: actor(homeId, membershipId, userId),
          homeId,
          supplyEntryId: created.id,
        });
        const beforeEntry = await entryRow(database.pool, created.id);
        const beforeClaim = await claimRow(database.pool, claimed.id);

        await assert.rejects(
          () =>
            createMarkSupplyEntryObtained({
              runTransaction: (work) =>
                runInReadCommittedTransaction(database.pool, work),
              lockHomeAndExactMemberships,
              supplies: {
                lockSupplyEntryByHomeAndId: (tx, home, id) =>
                  supplies.lockSupplyEntryByHomeAndId(tx, home, id),
                lockActiveClaimByEntry: (tx, home, id) =>
                  supplies.lockActiveClaimByEntry(tx, home, id),
                releaseActiveClaimForEntryTerminalization: (tx, input) =>
                  supplies.releaseActiveClaimForEntryTerminalization(tx, input),
                terminalizeSupplyEntryAsObtained: () =>
                  Promise.reject(
                    new Error('force rollback before entry update'),
                  ),
              },
              clock: { now: () => OCCURRED },
            })({
              actor: actor(homeId, membershipId, userId),
              homeId,
              supplyEntryId: created.id,
            }),
          /force rollback before entry update/,
        );

        const afterEntry = await entryRow(database.pool, created.id);
        const afterClaim = await claimRow(database.pool, claimed.id);
        assert.equal(afterEntry.status, 'OPEN');
        assert.equal(afterEntry.obtainedAt, null);
        assert.equal(afterEntry.canceledAt, null);
        assert.equal(
          afterEntry.updatedAt.getTime(),
          beforeEntry.updatedAt.getTime(),
        );
        assert.equal(afterClaim.releasedAt, null);
        assert.equal(afterClaim.releaseReason, null);
        assert.equal(
          afterClaim.updatedAt.getTime(),
          beforeClaim.updatedAt.getTime(),
        );
        assert.equal(await supplyOutboxCount(database.pool, [homeId]), 0);
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
    'rolls back Case B: both writes then failed commit',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const supplies = createSupplyRepository(database.pool);
      const create = createCreateSupplyEntryFromPool(database.pool);
      const claim = createClaimSupplyEntryFromPool(database.pool);
      const userId = randomUUID();
      const homeId = createUuidV7();
      const membershipId = createUuidV7();

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, { id: homeId, name: 'Rollback B' });
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ROOMMATE',
        });
        const created = await create({
          actor: actor(homeId, membershipId, userId),
          homeId,
          title: 'Case B',
        });
        const claimed = await claim({
          actor: actor(homeId, membershipId, userId),
          homeId,
          supplyEntryId: created.id,
        });
        const beforeEntry = await entryRow(database.pool, created.id);
        const beforeClaim = await claimRow(database.pool, claimed.id);

        await assert.rejects(
          () =>
            createCancelSupplyEntry({
              runTransaction: (work) =>
                runInReadCommittedTransaction(database.pool, work),
              lockHomeAndExactMemberships,
              supplies: {
                lockSupplyEntryByHomeAndId: (tx, home, id) =>
                  supplies.lockSupplyEntryByHomeAndId(tx, home, id),
                lockActiveClaimByEntry: (tx, home, id) =>
                  supplies.lockActiveClaimByEntry(tx, home, id),
                releaseActiveClaimForEntryTerminalization: (tx, input) =>
                  supplies.releaseActiveClaimForEntryTerminalization(tx, input),
                terminalizeSupplyEntryAsCanceled: async (tx, input) => {
                  await supplies.terminalizeSupplyEntryAsCanceled(tx, input);
                  throw new Error('force rollback before commit');
                },
              },
              clock: { now: () => OCCURRED },
            })({
              actor: actor(homeId, membershipId, userId),
              homeId,
              supplyEntryId: created.id,
            }),
          /force rollback before commit/,
        );

        const afterEntry = await entryRow(database.pool, created.id);
        const afterClaim = await claimRow(database.pool, claimed.id);
        assert.deepEqual(afterEntry, beforeEntry);
        assert.deepEqual(afterClaim, beforeClaim);
        assert.equal(await supplyOutboxCount(database.pool, [homeId]), 0);
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
