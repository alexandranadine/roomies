import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { lockHomeAndExactMemberships } from '../../domains/homes/lock-home-and-exact-memberships.js';
import { SupplyClaimNotActiveError } from '../../domains/supplies/errors.js';
import {
  createSupplyRepository,
  type NewSupplyClaim,
  type NewSupplyEntry,
} from '../../domains/supplies/repository.js';
import type { SupplyClaimReleaseReason } from '../../domains/supplies/supply.js';
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
import { createClaimSupplyEntryFromPool } from './claim-supply-entry.js';
import { createCreateSupplyEntryFromPool } from './create-supply-entry.js';
import { createMembershipEndingSupplyCleanupFromPool } from './membership-ending-supply-cleanup.js';
import {
  createReleaseSupplyClaim,
  createReleaseSupplyClaimFromPool,
} from './release-supply-claim.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const OCCURRED = new Date('2026-09-13T18:30:00.000Z');
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

async function insertClaim(pool: Pool, claim: NewSupplyClaim): Promise<void> {
  const supplies = createSupplyRepository(pool);
  await runInReadCommittedTransaction(pool, async (tx) => {
    await supplies.insertSupplyClaim(tx, claim);
  });
}

async function claimRow(
  pool: Pool,
  claimId: string,
): Promise<{
  releasedAt: Date | null;
  releaseReason: string | null;
  updatedAt: Date;
  claimedAt: Date;
  createdAt: Date;
}> {
  const result = await pool.query<{
    released_at: Date | null;
    release_reason: string | null;
    updated_at: Date;
    claimed_at: Date;
    created_at: Date;
  }>(
    `SELECT released_at, release_reason, updated_at, claimed_at, created_at
     FROM supply_claims WHERE id = $1`,
    [claimId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('claim missing');
  }
  return {
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
    updatedAt: row.updated_at,
    claimedAt: row.claimed_at,
    createdAt: row.created_at,
  };
}

void describe('releaseSupplyClaim PostgreSQL', () => {
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
    'covers claimant success, concealment, inactive conflicts, clock, and no outbox',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const create = createCreateSupplyEntryFromPool(database.pool);
      const claim = createClaimSupplyEntryFromPool(database.pool);
      const release = createReleaseSupplyClaimFromPool(database.pool);
      const supplies = createSupplyRepository(database.pool);
      const userA = randomUUID();
      const userB = randomUUID();
      const homeA = createUuidV7();
      const homeB = createUuidV7();
      const membershipA = createUuidV7();
      const membershipRoommate = createUuidV7();
      const otherMembership = createUuidV7();
      const userIds = [userA, userB];
      const homeIds = [homeA, homeB];

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, homeA, 'Home A');
        await insertHome(database.pool, homeB, 'Home B');
        await insertMembership(database.pool, {
          id: membershipA,
          homeId: homeA,
          userId: userA,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: membershipRoommate,
          homeId: homeA,
          userId: userB,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: otherMembership,
          homeId: homeB,
          userId: userB,
          role: 'ROOMMATE',
        });

        const created = await create({
          actor: actor(homeA, membershipA, userA),
          homeId: homeA,
          title: 'Release me',
        });
        const claimed = await claim({
          actor: actor(homeA, membershipA, userA),
          homeId: homeA,
          supplyEntryId: created.id,
        });

        await assert.rejects(
          () =>
            release({
              actor: actor(homeA, membershipRoommate, userB),
              homeId: homeA,
              supplyEntryId: created.id,
            }),
          ConcealedNotFoundError,
        );

        await database.pool.query(
          "UPDATE memberships SET role = 'ADMIN' WHERE id = $1",
          [membershipRoommate],
        );
        await assert.rejects(
          () =>
            release({
              actor: actor(homeA, membershipRoommate, userB, 'ADMIN'),
              homeId: homeA,
              supplyEntryId: created.id,
            }),
          ConcealedNotFoundError,
        );

        const creatorOnly = await create({
          actor: actor(homeA, membershipA, userA),
          homeId: homeA,
          title: 'Created by A claimed by B',
        });
        await claim({
          actor: actor(homeA, membershipRoommate, userB, 'ADMIN'),
          homeId: homeA,
          supplyEntryId: creatorOnly.id,
        });
        await assert.rejects(
          () =>
            release({
              actor: actor(homeA, membershipA, userA),
              homeId: homeA,
              supplyEntryId: creatorOnly.id,
            }),
          ConcealedNotFoundError,
        );

        let clockCalls = 0;
        await createReleaseSupplyClaim({
          runTransaction: (work) =>
            runInReadCommittedTransaction(database.pool, work),
          lockHomeAndExactMemberships,
          supplies,
          clock: {
            now() {
              clockCalls += 1;
              return OCCURRED;
            },
          },
        })({
          actor: actor(homeA, membershipA, userA),
          homeId: homeA,
          supplyEntryId: created.id,
        });
        assert.equal(clockCalls, 1);
        const first = await claimRow(database.pool, claimed.id);
        assert.equal(first.releaseReason, 'CLAIMANT_RELEASED');
        assert.equal(first.releasedAt?.getTime(), OCCURRED.getTime());
        assert.equal(first.updatedAt.getTime(), OCCURRED.getTime());
        assert.equal(first.claimedAt.getTime(), first.createdAt.getTime());

        await assert.rejects(
          () =>
            release({
              actor: actor(homeA, membershipA, userA),
              homeId: homeA,
              supplyEntryId: created.id,
            }),
          SupplyClaimNotActiveError,
        );
        const afterRepeat = await claimRow(database.pool, claimed.id);
        assert.equal(
          afterRepeat.releasedAt?.getTime(),
          first.releasedAt?.getTime(),
        );
        assert.equal(afterRepeat.releaseReason, 'CLAIMANT_RELEASED');

        const emptyEntry = await create({
          actor: actor(homeA, membershipA, userA),
          homeId: homeA,
          title: 'Never claimed',
        });
        await assert.rejects(
          () =>
            release({
              actor: actor(homeA, membershipA, userA),
              homeId: homeA,
              supplyEntryId: emptyEntry.id,
            }),
          SupplyClaimNotActiveError,
        );

        const historyId = createUuidV7();
        const historyEntry = createUuidV7();
        await insertEntry(database.pool, {
          id: historyEntry,
          homeId: homeA,
          title: 'History only',
          status: 'OPEN',
          createdByMembershipId: membershipA,
          obtainedAt: null,
          canceledAt: null,
          createdAt: PRIOR,
          updatedAt: PRIOR,
        });
        await insertClaim(database.pool, {
          id: historyId,
          homeId: homeA,
          supplyEntryId: historyEntry,
          claimantMembershipId: membershipA,
          claimedAt: PRIOR,
          releasedAt: PRIOR,
          releaseReason: 'CLAIMANT_RELEASED',
          createdAt: PRIOR,
          updatedAt: PRIOR,
        });
        await assert.rejects(
          () =>
            release({
              actor: actor(homeA, membershipA, userA),
              homeId: homeA,
              supplyEntryId: historyEntry,
            }),
          SupplyClaimNotActiveError,
        );

        await database.pool.query(
          'UPDATE memberships SET ended_at = $2 WHERE id = $1',
          [membershipA, OCCURRED],
        );
        const laterTenure = createUuidV7();
        await insertMembership(database.pool, {
          id: laterTenure,
          homeId: homeA,
          userId: userA,
          role: 'ROOMMATE',
        });
        const oldClaimEntry = await create({
          actor: actor(homeA, laterTenure, userA),
          homeId: homeA,
          title: 'Old tenure claim',
        });
        const oldClaimId = createUuidV7();
        await insertClaim(database.pool, {
          id: oldClaimId,
          homeId: homeA,
          supplyEntryId: oldClaimEntry.id,
          claimantMembershipId: membershipA,
          claimedAt: PRIOR,
          releasedAt: null,
          releaseReason: null,
          createdAt: PRIOR,
          updatedAt: PRIOR,
        });
        await assert.rejects(
          () =>
            release({
              actor: actor(homeA, laterTenure, userA),
              homeId: homeA,
              supplyEntryId: oldClaimEntry.id,
            }),
          ConcealedNotFoundError,
        );
        assert.equal(
          (await claimRow(database.pool, oldClaimId)).releaseReason,
          null,
        );

        const foreign = await create({
          actor: actor(homeB, otherMembership, userB),
          homeId: homeB,
          title: 'Foreign',
        });
        await assert.rejects(
          () =>
            release({
              actor: actor(homeA, laterTenure, userA),
              homeId: homeA,
              supplyEntryId: foreign.id,
            }),
          ConcealedNotFoundError,
        );
        await assert.rejects(
          () =>
            release({
              actor: actor(homeA, laterTenure, userA),
              homeId: homeA,
              supplyEntryId: createUuidV7(),
            }),
          ConcealedNotFoundError,
        );

        const leftoverEvents = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM outbox_events
           WHERE home_id = ANY($1) AND event_type LIKE 'supply.%'`,
          [homeIds],
        );
        assert.equal(leftoverEvents.rows[0]?.count, '0');
      } finally {
        await cleanup(database.pool, { userIds, homeIds });
        await database.close();
      }
    },
  );

  void it(
    'does not overwrite historical terminal release reasons',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const supplies = createSupplyRepository(database.pool);
      const userId = randomUUID();
      const homeId = createUuidV7();
      const membershipId = createUuidV7();

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, homeId, 'Immutable');
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ROOMMATE',
        });

        for (const reason of [
          'ENTRY_OBTAINED',
          'ENTRY_CANCELED',
          'MEMBERSHIP_ENDED',
          'CLAIMANT_RELEASED',
        ] as const satisfies readonly SupplyClaimReleaseReason[]) {
          const entryId = createUuidV7();
          const claimId = createUuidV7();
          await insertEntry(database.pool, {
            id: entryId,
            homeId,
            title: reason,
            status: 'OPEN',
            createdByMembershipId: membershipId,
            obtainedAt: null,
            canceledAt: null,
            createdAt: PRIOR,
            updatedAt: PRIOR,
          });
          await insertClaim(database.pool, {
            id: claimId,
            homeId,
            supplyEntryId: entryId,
            claimantMembershipId: membershipId,
            claimedAt: PRIOR,
            releasedAt: PRIOR,
            releaseReason: reason,
            createdAt: PRIOR,
            updatedAt: PRIOR,
          });
          const updated = await runInReadCommittedTransaction(
            database.pool,
            async (tx) =>
              supplies.releaseActiveClaimOwnedByMembership(tx, {
                claimId,
                homeId,
                supplyEntryId: entryId,
                claimantMembershipId: membershipId,
                releasedAt: OCCURRED,
              }),
          );
          assert.equal(updated, null);
          const row = await claimRow(database.pool, claimId);
          assert.equal(row.releaseReason, reason);
          assert.equal(row.releasedAt?.getTime(), PRIOR.getTime());
          assert.equal(row.updatedAt.getTime(), PRIOR.getTime());
        }
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
    'rolls back a failed release and leaves the claim active',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const supplies = createSupplyRepository(database.pool);
      const userId = randomUUID();
      const homeId = createUuidV7();
      const membershipId = createUuidV7();
      const create = createCreateSupplyEntryFromPool(database.pool);
      const claim = createClaimSupplyEntryFromPool(database.pool);

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, homeId, 'Release rollback');
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ROOMMATE',
        });
        const created = await create({
          actor: actor(homeId, membershipId, userId),
          homeId,
          title: 'Rollback release',
        });
        const claimed = await claim({
          actor: actor(homeId, membershipId, userId),
          homeId,
          supplyEntryId: created.id,
        });

        await assert.rejects(
          () =>
            createReleaseSupplyClaim({
              runTransaction: (work) =>
                runInReadCommittedTransaction(database.pool, work),
              lockHomeAndExactMemberships,
              supplies: {
                lockSupplyEntryByHomeAndId: (tx, home, id) =>
                  supplies.lockSupplyEntryByHomeAndId(tx, home, id),
                lockActiveClaimByEntry: (tx, home, id) =>
                  supplies.lockActiveClaimByEntry(tx, home, id),
                releaseActiveClaimOwnedByMembership: async (tx, input) => {
                  await supplies.releaseActiveClaimOwnedByMembership(tx, input);
                  throw new Error('force rollback');
                },
              },
              clock: { now: () => OCCURRED },
            })({
              actor: actor(homeId, membershipId, userId),
              homeId,
              supplyEntryId: created.id,
            }),
          /force rollback/,
        );

        const row = await claimRow(database.pool, claimed.id);
        assert.equal(row.releasedAt, null);
        assert.equal(row.releaseReason, null);
        const events = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM outbox_events
           WHERE home_id = $1 AND event_type LIKE 'supply.%'`,
          [homeId],
        );
        assert.equal(events.rows[0]?.count, '0');
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
    'keeps a MEMBERSHIP_ENDED reason when ending runs after manual release',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const create = createCreateSupplyEntryFromPool(database.pool);
      const claim = createClaimSupplyEntryFromPool(database.pool);
      const release = createReleaseSupplyClaimFromPool(database.pool);
      const userId = randomUUID();
      const otherId = randomUUID();
      const homeId = createUuidV7();
      const membershipId = createUuidV7();
      const adminId = createUuidV7();

      try {
        await insertUser(database.pool, userId);
        await insertUser(database.pool, otherId);
        await insertHome(database.pool, homeId, 'Release then end');
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: adminId,
          homeId,
          userId: otherId,
          role: 'ADMIN',
        });
        const created = await create({
          actor: actor(homeId, membershipId, userId),
          homeId,
          title: 'Manual then end',
        });
        const claimed = await claim({
          actor: actor(homeId, membershipId, userId),
          homeId,
          supplyEntryId: created.id,
        });
        await release({
          actor: actor(homeId, membershipId, userId),
          homeId,
          supplyEntryId: created.id,
        });
        const first = await claimRow(database.pool, claimed.id);
        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await createMembershipEndingSupplyCleanupFromPool(
            database.pool,
          ).handleMembershipEnded(tx, {
            homeId,
            membershipId,
            endedAt: OCCURRED,
            cause: 'VOLUNTARY_LEAVE',
          });
        });
        const afterEnd = await claimRow(database.pool, claimed.id);
        assert.equal(afterEnd.releaseReason, 'CLAIMANT_RELEASED');
        assert.equal(
          afterEnd.releasedAt?.getTime(),
          first.releasedAt?.getTime(),
        );
      } finally {
        await cleanup(database.pool, {
          userIds: [userId, otherId],
          homeIds: [homeId],
        });
        await database.close();
      }
    },
  );
});
