import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createSupplyRepository } from '../../domains/supplies/repository.js';
import { toSupplyEntryDto } from '../../domains/supplies/supply-entry-dto.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
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
import { createListHomeSuppliesFromPool } from './list-home-supplies.js';
import { createMembershipEndingSupplyCleanupFromPool } from './membership-ending-supply-cleanup.js';
import { createReleaseSupplyClaimFromPool } from './release-supply-claim.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const OCCURRED = new Date('2026-12-31T18:45:00.000Z');

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
): ActiveHomeActor {
  return { userId, membershipId, homeId, role: 'ROOMMATE' };
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

void describe('Supply list activeClaim projection PostgreSQL', () => {
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
    'projects the current active claim and preserves M4.2 ordering',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const create = createCreateSupplyEntryFromPool(database.pool);
      const list = createListHomeSuppliesFromPool(database.pool);
      const claim = createClaimSupplyEntryFromPool(database.pool);
      const release = createReleaseSupplyClaimFromPool(database.pool);
      const userA = randomUUID();
      const userB = randomUUID();
      const homeA = createUuidV7();
      const homeB = createUuidV7();
      const membershipA = createUuidV7();
      const membershipB = createUuidV7();
      const otherMembership = createUuidV7();

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
          id: membershipB,
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

        const first = await create({
          actor: actor(homeA, membershipA, userA),
          homeId: homeA,
          title: 'First',
        });
        const createDto = toSupplyEntryDto(first);
        assert.equal(createDto.activeClaim, null);

        const empty = await list({
          actor: actor(homeA, membershipA, userA),
          homeId: homeA,
        });
        assert.equal(
          empty.find((row) => row.id === first.id)?.activeClaim,
          null,
        );

        const claimed = await claim({
          actor: actor(homeA, membershipA, userA),
          homeId: homeA,
          supplyEntryId: first.id,
        });
        let listQueries = 0;
        const counting = createSupplyRepository({
          query: ((text: string, values?: unknown[]) => {
            if (
              typeof text === 'string' &&
              text.includes('FROM supply_entries e')
            ) {
              listQueries += 1;
            }
            return database.pool.query(text, values);
          }) as Pool['query'],
        } as Pool);
        const listed = await counting.listSupplyEntriesByHome(homeA);
        assert.equal(listQueries, 1);
        const projected = listed.find((row) => row.id === first.id);
        assert.equal(projected?.activeClaim?.claimantMembershipId, membershipA);
        assert.ok(projected?.activeClaim?.claimedAt);
        assert.equal('id' in (projected?.activeClaim ?? {}), false);
        assert.equal('homeId' in (projected?.activeClaim ?? {}), false);

        const otherHome = await create({
          actor: actor(homeB, otherMembership, userB),
          homeId: homeB,
          title: 'Other home',
        });
        await claim({
          actor: actor(homeB, otherMembership, userB),
          homeId: homeB,
          supplyEntryId: otherHome.id,
        });
        const listedA = await list({
          actor: actor(homeA, membershipA, userA),
          homeId: homeA,
        });
        assert.equal(
          listedA.some((row) => row.id === otherHome.id),
          false,
        );
        assert.equal(
          listedA.find((row) => row.id === first.id)?.activeClaim
            ?.claimantMembershipId,
          membershipA,
        );

        await release({
          actor: actor(homeA, membershipA, userA),
          homeId: homeA,
          supplyEntryId: first.id,
        });
        const afterRelease = await list({
          actor: actor(homeA, membershipA, userA),
          homeId: homeA,
        });
        assert.equal(
          afterRelease.find((row) => row.id === first.id)?.activeClaim,
          null,
        );

        const second = await claim({
          actor: actor(homeA, membershipB, userB),
          homeId: homeA,
          supplyEntryId: first.id,
        });
        const afterReclaim = await list({
          actor: actor(homeA, membershipA, userA),
          homeId: homeA,
        });
        const reclaimProjection = afterReclaim.find(
          (row) => row.id === first.id,
        )?.activeClaim;
        assert.equal(reclaimProjection?.claimantMembershipId, membershipB);
        assert.notEqual(
          reclaimProjection?.claimedAt.getTime(),
          claimed.claimedAt.getTime(),
        );
        assert.equal(second.claimantMembershipId, membershipB);

        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await createMembershipEndingSupplyCleanupFromPool(
            database.pool,
          ).handleMembershipEnded(tx, {
            homeId: homeA,
            membershipId: membershipB,
            endedAt: OCCURRED,
            cause: 'VOLUNTARY_LEAVE',
          });
        });
        const afterEnd = await list({
          actor: actor(homeA, membershipA, userA),
          homeId: homeA,
        });
        assert.equal(
          afterEnd.find((row) => row.id === first.id)?.activeClaim,
          null,
        );

        const olderOpen = createUuidV7();
        const newerOpen = createUuidV7();
        const terminal = createUuidV7();
        const supplies = createSupplyRepository(database.pool);
        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await supplies.insertSupplyEntry(tx, {
            id: olderOpen,
            homeId: homeA,
            title: 'Older open',
            status: 'OPEN',
            createdByMembershipId: membershipA,
            obtainedAt: null,
            obtainedByMembershipId: null,
            canceledAt: null,
            createdAt: new Date('2026-09-01T00:00:00.000Z'),
            updatedAt: new Date('2026-09-01T00:00:00.000Z'),
          });
          await supplies.insertSupplyEntry(tx, {
            id: newerOpen,
            homeId: homeA,
            title: 'Newer open',
            status: 'OPEN',
            createdByMembershipId: membershipA,
            obtainedAt: null,
            obtainedByMembershipId: null,
            canceledAt: null,
            createdAt: new Date('2026-09-01T00:00:01.000Z'),
            updatedAt: new Date('2026-09-01T00:00:01.000Z'),
          });
          await supplies.insertSupplyEntry(tx, {
            id: terminal,
            homeId: homeA,
            title: 'Terminal',
            status: 'CANCELED',
            createdByMembershipId: membershipA,
            obtainedAt: null,
            obtainedByMembershipId: null,
            canceledAt: new Date('2026-09-10T12:00:00.000Z'),
            createdAt: new Date('2026-09-01T00:00:00.000Z'),
            updatedAt: new Date('2026-09-10T12:00:00.000Z'),
          });
        });
        const ordered = await list({
          actor: actor(homeA, membershipA, userA),
          homeId: homeA,
        });
        const ids = ordered.map((row) => row.id);
        assert.ok(ids.indexOf(olderOpen) < ids.indexOf(newerOpen));
        assert.ok(ids.indexOf(newerOpen) < ids.indexOf(first.id));
        assert.ok(ids.indexOf(first.id) < ids.indexOf(terminal));
        const openOnly = await list({
          actor: actor(homeA, membershipA, userA),
          homeId: homeA,
          status: 'OPEN',
        });
        assert.equal(
          openOnly.every((row) => row.status === 'OPEN'),
          true,
        );
        assert.equal(
          openOnly.some((row) => row.id === terminal),
          false,
        );
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
