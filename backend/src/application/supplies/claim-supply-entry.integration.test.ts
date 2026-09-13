import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { lockHomeAndExactMemberships } from '../../domains/homes/lock-home-and-exact-memberships.js';
import {
  SupplyAlreadyClaimedError,
  SupplyNotOpenError,
} from '../../domains/supplies/errors.js';
import {
  createSupplyRepository,
  type NewSupplyClaim,
  type NewSupplyEntry,
} from '../../domains/supplies/repository.js';
import { toSupplyClaimDto } from '../../domains/supplies/supply-claim-dto.js';
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
import {
  createClaimSupplyEntry,
  createClaimSupplyEntryFromPool,
} from './claim-supply-entry.js';
import { createCreateSupplyEntryFromPool } from './create-supply-entry.js';
import { createMembershipEndingSupplyCleanupFromPool } from './membership-ending-supply-cleanup.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OCCURRED = new Date('2026-09-13T18:00:00.000Z');

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

function roommate(
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

async function insertClaim(pool: Pool, claim: NewSupplyClaim): Promise<void> {
  const supplies = createSupplyRepository(pool);
  await runInReadCommittedTransaction(pool, async (tx) => {
    await supplies.insertSupplyClaim(tx, claim);
  });
}

function openEntry(input: {
  id: string;
  homeId: string;
  createdByMembershipId: string;
  title?: string;
  status?: NewSupplyEntry['status'];
  obtainedAt?: Date | null;
  canceledAt?: Date | null;
}): NewSupplyEntry {
  const status = input.status ?? 'OPEN';
  return {
    id: input.id,
    homeId: input.homeId,
    title: input.title ?? 'Paper towels',
    status,
    createdByMembershipId: input.createdByMembershipId,
    obtainedAt: input.obtainedAt ?? (status === 'OBTAINED' ? OCCURRED : null),
    canceledAt: input.canceledAt ?? (status === 'CANCELED' ? OCCURRED : null),
    createdAt: OCCURRED,
    updatedAt: OCCURRED,
  };
}

void describe('claimSupplyEntry PostgreSQL', () => {
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
    'covers Roommate/Admin claim, conflicts, concealment, rejoin, and no outbox',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const claim = createClaimSupplyEntryFromPool(database.pool);
      const create = createCreateSupplyEntryFromPool(database.pool);
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

        const created = await create({
          actor: roommate(homeA, membershipA, userA),
          homeId: homeA,
          title: 'Claimable',
        });
        let clockCalls = 0;
        const claimed = await createClaimSupplyEntry({
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
          ids: { next: () => createUuidV7() },
        })({
          actor: roommate(homeA, membershipA, userA),
          homeId: homeA,
          supplyEntryId: created.id,
        });
        assert.match(claimed.id, UUID_V7);
        assert.equal(clockCalls, 1);
        assert.equal(claimed.claimantMembershipId, membershipA);
        assert.equal(claimed.releasedAt, null);
        assert.equal(claimed.releaseReason, null);
        assert.equal(claimed.claimedAt.getTime(), claimed.createdAt.getTime());
        assert.equal(claimed.claimedAt.getTime(), claimed.updatedAt.getTime());

        const persisted = await database.pool.query<{
          claimant_membership_id: string;
          released_at: Date | null;
          release_reason: string | null;
        }>(
          `SELECT claimant_membership_id, released_at, release_reason
           FROM supply_claims WHERE id = $1`,
          [claimed.id],
        );
        assert.equal(persisted.rows[0]?.claimant_membership_id, membershipA);
        assert.equal(persisted.rows[0]?.released_at, null);
        assert.equal(persisted.rows[0]?.release_reason, null);

        const dto = toSupplyClaimDto(claimed);
        assert.equal('homeId' in dto, false);
        assert.equal('userId' in dto, false);
        assert.equal('createdAt' in dto, false);
        assert.equal(dto.releasedAt, null);

        await assert.rejects(
          () =>
            claim({
              actor: roommate(homeA, membershipAdmin, userB, 'ADMIN'),
              homeId: homeA,
              supplyEntryId: created.id,
            }),
          SupplyAlreadyClaimedError,
        );
        await assert.rejects(
          () =>
            claim({
              actor: roommate(homeA, membershipA, userA),
              homeId: homeA,
              supplyEntryId: created.id,
            }),
          SupplyAlreadyClaimedError,
        );

        const adminEntry = await create({
          actor: roommate(homeA, membershipAdmin, userB, 'ADMIN'),
          homeId: homeA,
          title: 'Admin claimable',
        });
        const adminClaim = await claim({
          actor: roommate(homeA, membershipAdmin, userB, 'ADMIN'),
          homeId: homeA,
          supplyEntryId: adminEntry.id,
        });
        assert.equal(adminClaim.claimantMembershipId, membershipAdmin);

        const obtainedId = createUuidV7();
        const canceledId = createUuidV7();
        await insertEntry(
          database.pool,
          openEntry({
            id: obtainedId,
            homeId: homeA,
            createdByMembershipId: membershipA,
            title: 'Obtained',
            status: 'OBTAINED',
          }),
        );
        await insertEntry(
          database.pool,
          openEntry({
            id: canceledId,
            homeId: homeA,
            createdByMembershipId: membershipA,
            title: 'Canceled',
            status: 'CANCELED',
          }),
        );
        await assert.rejects(
          () =>
            claim({
              actor: roommate(homeA, membershipA, userA),
              homeId: homeA,
              supplyEntryId: obtainedId,
            }),
          SupplyNotOpenError,
        );
        await assert.rejects(
          () =>
            claim({
              actor: roommate(homeA, membershipA, userA),
              homeId: homeA,
              supplyEntryId: canceledId,
            }),
          SupplyNotOpenError,
        );

        const foreignEntry = await create({
          actor: roommate(homeB, otherMembership, userB),
          homeId: homeB,
          title: 'Foreign',
        });
        await assert.rejects(
          () =>
            claim({
              actor: roommate(homeA, membershipA, userA),
              homeId: homeA,
              supplyEntryId: foreignEntry.id,
            }),
          ConcealedNotFoundError,
        );
        await assert.rejects(
          () =>
            claim({
              actor: roommate(homeA, membershipA, userA),
              homeId: homeA,
              supplyEntryId: createUuidV7(),
            }),
          ConcealedNotFoundError,
        );
        await assert.rejects(
          () =>
            claim({
              actor: roommate(homeA, endedMembership, userA),
              homeId: homeA,
              supplyEntryId: adminEntry.id,
            }),
          ConcealedNotFoundError,
        );

        const cleanupTx = createMembershipEndingSupplyCleanupFromPool(
          database.pool,
        );
        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await cleanupTx.handleMembershipEnded(tx, {
            homeId: homeA,
            membershipId: membershipA,
            endedAt: OCCURRED,
            cause: 'VOLUNTARY_LEAVE',
          });
        });

        const released = await database.pool.query<{
          release_reason: string | null;
        }>('SELECT release_reason FROM supply_claims WHERE id = $1', [
          claimed.id,
        ]);
        assert.equal(released.rows[0]?.release_reason, 'MEMBERSHIP_ENDED');

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
        const reclaimed = await claim({
          actor: roommate(homeA, rejoined, userA),
          homeId: homeA,
          supplyEntryId: created.id,
        });
        assert.equal(reclaimed.claimantMembershipId, rejoined);
        assert.notEqual(reclaimed.id, claimed.id);

        await assert.rejects(
          () =>
            insertClaim(database.pool, {
              id: createUuidV7(),
              homeId: homeA,
              supplyEntryId: created.id,
              claimantMembershipId: membershipAdmin,
              claimedAt: OCCURRED,
              releasedAt: null,
              releaseReason: null,
              createdAt: OCCURRED,
              updatedAt: OCCURRED,
            }),
          SupplyAlreadyClaimedError,
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
    'rolls back a failed claim insert and leaves no row or outbox',
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

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, { id: homeId, name: 'Rollback' });
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ROOMMATE',
        });
        await insertEntry(
          database.pool,
          openEntry({
            id: entryId,
            homeId,
            createdByMembershipId: membershipId,
          }),
        );

        await assert.rejects(
          () =>
            createClaimSupplyEntry({
              runTransaction: (work) =>
                runInReadCommittedTransaction(database.pool, work),
              lockHomeAndExactMemberships,
              supplies: {
                lockSupplyEntryByHomeAndId: (tx, home, id) =>
                  supplies.lockSupplyEntryByHomeAndId(tx, home, id),
                lockActiveClaimByEntry: (tx, home, id) =>
                  supplies.lockActiveClaimByEntry(tx, home, id),
                insertSupplyClaim: async (tx, input) => {
                  await supplies.insertSupplyClaim(tx, input);
                  throw new Error('force rollback');
                },
              },
              clock: { now: () => OCCURRED },
              ids: { next: () => createUuidV7() },
            })({
              actor: roommate(homeId, membershipId, userId),
              homeId,
              supplyEntryId: entryId,
            }),
          /force rollback/,
        );

        const leftover = await database.pool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM supply_claims WHERE home_id = $1',
          [homeId],
        );
        assert.equal(leftover.rows[0]?.count, '0');
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
});
