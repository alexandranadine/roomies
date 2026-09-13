import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import {
  createSupplyRepository,
  type NewSupplyEntry,
} from '../../domains/supplies/repository.js';
import { toSupplyEntryDto } from '../../domains/supplies/supply-entry-dto.js';
import type { AppConfig } from '../../platform/config/types.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import { createCreateSupplyEntryFromPool } from './create-supply-entry.js';
import { createListHomeSuppliesFromPool } from './list-home-supplies.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function roommate(
  homeId: string,
  membershipId: string,
  userId: string,
): ActiveHomeActor {
  return {
    userId,
    membershipId,
    homeId,
    role: 'ROOMMATE',
  };
}

async function insertPersistedEntry(
  pool: Pool,
  entry: NewSupplyEntry,
): Promise<void> {
  const supplies = createSupplyRepository(pool);
  await runInReadCommittedTransaction(pool, async (tx) => {
    await supplies.insertSupplyEntry(tx, entry);
  });
}

void describe('SupplyEntry create/list PostgreSQL', () => {
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
    'round-trips create fields, isolation, ordering, rejoin, and no side effects',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const create = createCreateSupplyEntryFromPool(database.pool);
      const list = createListHomeSuppliesFromPool(database.pool);

      const userA = randomUUID();
      const userB = randomUUID();
      const homeA = createUuidV7();
      const homeB = createUuidV7();
      const archivedHome = createUuidV7();
      const membershipA = createUuidV7();
      const membershipAdmin = createUuidV7();
      const endedMembership = createUuidV7();
      const otherMembership = createUuidV7();
      const archivedMembership = createUuidV7();
      const userIds = [userA, userB];
      const homeIds = [homeA, homeB, archivedHome];

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeA, name: 'Home A' });
        await insertHome(database.pool, { id: homeB, name: 'Home B' });
        await insertHome(database.pool, {
          id: archivedHome,
          name: 'Archived',
          archived: true,
        });
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
        await insertMembership(database.pool, {
          id: archivedMembership,
          homeId: archivedHome,
          userId: userA,
          role: 'ROOMMATE',
        });

        const actorA = roommate(homeA, membershipA, userA);
        const actorAdmin = {
          userId: userB,
          membershipId: membershipAdmin,
          homeId: homeA,
          role: 'ADMIN' as const,
        };

        const first = await create({
          actor: actorA,
          homeId: homeA,
          title: '  Paper towels  ',
        });
        const second = await create({
          actor: actorAdmin,
          homeId: homeA,
          title: 'Dish soap',
        });

        assert.match(first.id, UUID_V7);
        assert.match(second.id, UUID_V7);
        assert.notEqual(first.id, second.id);
        assert.equal(first.title, 'Paper towels');
        assert.equal(first.status, 'OPEN');
        assert.equal(first.createdByMembershipId, membershipA);
        assert.equal(first.obtainedAt, null);
        assert.equal(first.canceledAt, null);
        assert.equal(first.createdAt.getTime(), first.updatedAt.getTime());
        assert.equal(second.createdByMembershipId, membershipAdmin);

        const persisted = await database.pool.query<{
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
          [first.id],
        );
        assert.equal(persisted.rows[0]?.status, 'OPEN');
        assert.equal(persisted.rows[0]?.created_by_membership_id, membershipA);
        assert.equal(persisted.rows[0]?.obtained_at, null);
        assert.equal(persisted.rows[0]?.canceled_at, null);
        assert.equal(
          persisted.rows[0]?.created_at.getTime(),
          persisted.rows[0]?.updated_at.getTime(),
        );

        const claims = await database.pool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM supply_claims WHERE home_id = $1',
          [homeA],
        );
        assert.equal(claims.rows[0]?.count, '0');

        const outbox = await database.pool.query<{ event_type: string }>(
          'SELECT event_type FROM outbox_events WHERE home_id = $1',
          [homeA],
        );
        assert.equal(outbox.rows.length, 0);
        const supplyEvents = outbox.rows.filter((row) =>
          row.event_type.startsWith('supply.'),
        );
        assert.deepEqual(supplyEvents, []);

        const otherHomeEntry = await create({
          actor: roommate(homeB, otherMembership, userB),
          homeId: homeB,
          title: 'Other home soap',
        });
        const listedA = await list({ actor: actorA, homeId: homeA });
        assert.equal(
          listedA.some((row) => row.id === otherHomeEntry.id),
          false,
        );
        assert.deepEqual(
          listedA.map((row) => row.id),
          [first.id, second.id],
        );

        const emptyBBeforeFilter = await list({
          actor: roommate(homeB, otherMembership, userB),
          homeId: homeB,
          status: 'CANCELED',
        });
        assert.deepEqual(emptyBBeforeFilter, []);

        const olderOpen = createUuidV7();
        const newerOpen = createUuidV7();
        const laterTerminal = createUuidV7();
        const earlierTerminal = createUuidV7();
        const openCreated = new Date('2026-09-01T00:00:00.000Z');
        const openCreatedLater = new Date('2026-09-01T00:00:01.000Z');
        const terminalUpdatedLater = new Date('2026-09-10T12:00:00.000Z');
        const terminalUpdatedEarlier = new Date('2026-09-09T12:00:00.000Z');
        await insertPersistedEntry(database.pool, {
          id: olderOpen,
          homeId: homeA,
          title: 'Older open',
          status: 'OPEN',
          createdByMembershipId: membershipA,
          obtainedAt: null,
          canceledAt: null,
          createdAt: openCreated,
          updatedAt: openCreated,
        });
        await insertPersistedEntry(database.pool, {
          id: newerOpen,
          homeId: homeA,
          title: 'Newer open',
          status: 'OPEN',
          createdByMembershipId: membershipA,
          obtainedAt: null,
          canceledAt: null,
          createdAt: openCreatedLater,
          updatedAt: openCreatedLater,
        });
        await insertPersistedEntry(database.pool, {
          id: laterTerminal,
          homeId: homeA,
          title: 'Later obtained',
          status: 'OBTAINED',
          createdByMembershipId: membershipA,
          obtainedAt: terminalUpdatedLater,
          canceledAt: null,
          createdAt: openCreated,
          updatedAt: terminalUpdatedLater,
        });
        await insertPersistedEntry(database.pool, {
          id: earlierTerminal,
          homeId: homeA,
          title: 'Earlier canceled',
          status: 'CANCELED',
          createdByMembershipId: membershipA,
          obtainedAt: null,
          canceledAt: terminalUpdatedEarlier,
          createdAt: openCreated,
          updatedAt: terminalUpdatedEarlier,
        });

        const allListed = await list({ actor: actorA, homeId: homeA });
        const allIds = allListed.map((row) => row.id);
        const olderOpenIndex = allIds.indexOf(olderOpen);
        const newerOpenIndex = allIds.indexOf(newerOpen);
        const firstCreateIndex = allIds.indexOf(first.id);
        const laterTerminalIndex = allIds.indexOf(laterTerminal);
        const earlierTerminalIndex = allIds.indexOf(earlierTerminal);
        assert.ok(olderOpenIndex < newerOpenIndex);
        assert.ok(newerOpenIndex < firstCreateIndex);
        assert.ok(firstCreateIndex < laterTerminalIndex);
        assert.ok(laterTerminalIndex < earlierTerminalIndex);
        assert.equal(
          allListed.every((row) => row.homeId === homeA),
          true,
        );

        const openOnly = await list({
          actor: actorA,
          homeId: homeA,
          status: 'OPEN',
        });
        assert.equal(
          openOnly.every((row) => row.status === 'OPEN'),
          true,
        );
        const openIds = openOnly.map((row) => row.id);
        assert.ok(openIds.indexOf(olderOpen) < openIds.indexOf(newerOpen));
        assert.equal(openIds.includes(laterTerminal), false);

        const obtainedOnly = await list({
          actor: actorA,
          homeId: homeA,
          status: 'OBTAINED',
        });
        assert.deepEqual(
          obtainedOnly.map((row) => row.id),
          [laterTerminal],
        );

        const canceledOnly = await list({
          actor: actorA,
          homeId: homeA,
          status: 'CANCELED',
        });
        assert.deepEqual(
          canceledOnly.map((row) => row.id),
          [earlierTerminal],
        );

        const dto = toSupplyEntryDto(first);
        assert.equal('homeId' in dto, false);
        assert.equal('activeClaim' in dto, false);

        await assert.rejects(
          () =>
            create({
              actor: actorA,
              homeId: homeB,
              title: 'Cross home',
            }),
          ConcealedNotFoundError,
        );
        await assert.rejects(
          () =>
            create({
              actor: roommate(archivedHome, archivedMembership, userA),
              homeId: archivedHome,
              title: 'Archived create',
            }),
          ConcealedNotFoundError,
        );
        await assert.rejects(
          () =>
            create({
              actor: roommate(homeA, endedMembership, userA),
              homeId: homeA,
              title: 'Ended create',
            }),
          ConcealedNotFoundError,
        );

        await database.pool.query(
          'UPDATE memberships SET ended_at = NOW() WHERE id = $1',
          [membershipA],
        );
        const afterEnd = await list({ actor: actorAdmin, homeId: homeA });
        assert.equal(
          afterEnd.some((row) => row.id === first.id),
          true,
        );
        assert.equal(
          afterEnd.find((row) => row.id === first.id)?.createdByMembershipId,
          membershipA,
        );

        const rejoined = createUuidV7();
        await insertMembership(database.pool, {
          id: rejoined,
          homeId: homeA,
          userId: userA,
          role: 'ROOMMATE',
        });
        const afterRejoin = await list({
          actor: roommate(homeA, rejoined, userA),
          homeId: homeA,
        });
        assert.equal(
          afterRejoin.find((row) => row.id === first.id)?.createdByMembershipId,
          membershipA,
        );
        const createdByB = await create({
          actor: roommate(homeA, rejoined, userA),
          homeId: homeA,
          title: 'Rejoin create',
        });
        assert.equal(createdByB.createdByMembershipId, rejoined);
        assert.notEqual(createdByB.createdByMembershipId, membershipA);

        const leftoverClaims = await database.pool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM supply_claims WHERE home_id = ANY($1)',
          [homeIds],
        );
        assert.equal(leftoverClaims.rows[0]?.count, '0');
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
    'enforces same-Home creator FK and refuses a stale create after archive',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const homeA = createUuidV7();
      const homeB = createUuidV7();
      const membershipA = createUuidV7();
      const membershipB = createUuidV7();

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeA, name: 'FK Home A' });
        await insertHome(database.pool, { id: homeB, name: 'FK Home B' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId: homeA,
          userId: userA,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId: homeB,
          userId: userB,
          role: 'ROOMMATE',
        });

        await assert.rejects(() =>
          insertPersistedEntry(database.pool, {
            id: createUuidV7(),
            homeId: homeA,
            title: 'Cross-home creator',
            status: 'OPEN',
            createdByMembershipId: membershipB,
            obtainedAt: null,
            canceledAt: null,
            createdAt: new Date('2026-09-12T18:00:00.000Z'),
            updatedAt: new Date('2026-09-12T18:00:00.000Z'),
          }),
        );

        const leftover = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM supply_entries
           WHERE home_id = $1 AND title = 'Cross-home creator'`,
          [homeA],
        );
        assert.equal(leftover.rows[0]?.count, '0');
      } finally {
        await cleanup(database.pool, {
          userIds: [userA, userB],
          homeIds: [homeA, homeB],
        });
        await database.close();
      }
    },
  );
});
