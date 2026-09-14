import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import type { AppConfig } from '../../platform/config/types.js';
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import { findSupplyPulseSummary } from './find-supply-pulse-summary.js';
import { createSupplyRepository } from './repository.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const OCCURRED = new Date('2026-09-12T18:00:00.000Z');

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

async function insertHome(pool: Pool, id: string): Promise<void> {
  await pool.query(
    `INSERT INTO homes (id, name, timezone, archived_at, updated_at)
     VALUES ($1, 'Pulse Supplies', 'UTC', NULL, NOW())`,
    [id],
  );
}

async function insertMembership(
  pool: Pool,
  input: {
    id: string;
    homeId: string;
    userId: string;
    ended?: boolean;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO memberships (id, home_id, user_id, role, ended_at, ended_by_membership_id)
     VALUES ($1, $2, $3, 'ROOMMATE', $4, $5)`,
    [
      input.id,
      input.homeId,
      input.userId,
      input.ended === true ? new Date() : null,
      input.ended === true ? input.id : null,
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
    const remaining = await pool.query<{ id: string }>(
      'SELECT id FROM memberships WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    for (const row of remaining.rows) {
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

void describe('findSupplyPulseSummary PostgreSQL', () => {
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
    'counts OPEN Supplies and exact-Membership active claims only',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const databaseUrl = resolveSafeDedicatedTestDatabaseUrl();
      const database = createDatabasePool(testConfig(databaseUrl));
      const supplies = createSupplyRepository(database.pool);
      const userIds: string[] = [];
      const homeIds: string[] = [];

      try {
        const homeId = createUuidV7();
        const alexUser = createUuidV7();
        const jamieUser = createUuidV7();
        const alexA = createUuidV7();
        const alexB = createUuidV7();
        const jamie = createUuidV7();
        homeIds.push(homeId);
        userIds.push(alexUser, jamieUser);

        await insertUser(database.pool, alexUser);
        await insertUser(database.pool, jamieUser);
        await insertHome(database.pool, homeId);
        await insertMembership(database.pool, {
          id: alexA,
          homeId,
          userId: alexUser,
          ended: true,
        });
        await insertMembership(database.pool, {
          id: alexB,
          homeId,
          userId: alexUser,
        });
        await insertMembership(database.pool, {
          id: jamie,
          homeId,
          userId: jamieUser,
        });

        const empty = await runInReadCommittedTransaction(database.pool, (tx) =>
          findSupplyPulseSummary(tx, {
            homeId,
            requesterMembershipId: alexB,
          }),
        );
        assert.deepEqual(empty, {
          openCount: 0,
          unclaimedOpenCount: 0,
          claimedByMeCount: 0,
        });

        await runInReadCommittedTransaction(database.pool, async (tx) => {
          const unclaimed = await supplies.insertSupplyEntry(tx, {
            id: createUuidV7(),
            homeId,
            title: 'Unclaimed open',
            status: 'OPEN',
            createdByMembershipId: alexB,
            obtainedAt: null,
            obtainedByMembershipId: null,
            canceledAt: null,
            createdAt: OCCURRED,
            updatedAt: OCCURRED,
          });
          assert.ok(unclaimed.id);

          const mine = await supplies.insertSupplyEntry(tx, {
            id: createUuidV7(),
            homeId,
            title: 'Claimed by Alex B',
            status: 'OPEN',
            createdByMembershipId: alexB,
            obtainedAt: null,
            obtainedByMembershipId: null,
            canceledAt: null,
            createdAt: OCCURRED,
            updatedAt: OCCURRED,
          });
          await supplies.insertSupplyClaim(tx, {
            id: createUuidV7(),
            homeId,
            supplyEntryId: mine.id,
            claimantMembershipId: alexB,
            claimedAt: OCCURRED,
            releasedAt: null,
            releaseReason: null,
            createdAt: OCCURRED,
            updatedAt: OCCURRED,
          });

          const other = await supplies.insertSupplyEntry(tx, {
            id: createUuidV7(),
            homeId,
            title: 'Claimed by Jamie',
            status: 'OPEN',
            createdByMembershipId: jamie,
            obtainedAt: null,
            obtainedByMembershipId: null,
            canceledAt: null,
            createdAt: OCCURRED,
            updatedAt: OCCURRED,
          });
          await supplies.insertSupplyClaim(tx, {
            id: createUuidV7(),
            homeId,
            supplyEntryId: other.id,
            claimantMembershipId: jamie,
            claimedAt: OCCURRED,
            releasedAt: null,
            releaseReason: null,
            createdAt: OCCURRED,
            updatedAt: OCCURRED,
          });

          await supplies.insertSupplyEntry(tx, {
            id: createUuidV7(),
            homeId,
            title: 'Obtained',
            status: 'OBTAINED',
            createdByMembershipId: alexB,
            obtainedAt: OCCURRED,
            obtainedByMembershipId: alexB,
            canceledAt: null,
            createdAt: OCCURRED,
            updatedAt: OCCURRED,
          });
          await supplies.insertSupplyEntry(tx, {
            id: createUuidV7(),
            homeId,
            title: 'Canceled',
            status: 'CANCELED',
            createdByMembershipId: alexB,
            obtainedAt: null,
            obtainedByMembershipId: null,
            canceledAt: OCCURRED,
            createdAt: OCCURRED,
            updatedAt: OCCURRED,
          });

          const released = await supplies.insertSupplyEntry(tx, {
            id: createUuidV7(),
            homeId,
            title: 'Released historical claim',
            status: 'OPEN',
            createdByMembershipId: alexB,
            obtainedAt: null,
            obtainedByMembershipId: null,
            canceledAt: null,
            createdAt: OCCURRED,
            updatedAt: OCCURRED,
          });
          await supplies.insertSupplyClaim(tx, {
            id: createUuidV7(),
            homeId,
            supplyEntryId: released.id,
            claimantMembershipId: alexB,
            claimedAt: OCCURRED,
            releasedAt: OCCURRED,
            releaseReason: 'CLAIMANT_RELEASED',
            createdAt: OCCURRED,
            updatedAt: OCCURRED,
          });

          const historical = await supplies.insertSupplyEntry(tx, {
            id: createUuidV7(),
            homeId,
            title: 'Claimed by historical A',
            status: 'OPEN',
            createdByMembershipId: alexA,
            obtainedAt: null,
            obtainedByMembershipId: null,
            canceledAt: null,
            createdAt: OCCURRED,
            updatedAt: OCCURRED,
          });
          await supplies.insertSupplyClaim(tx, {
            id: createUuidV7(),
            homeId,
            supplyEntryId: historical.id,
            claimantMembershipId: alexA,
            claimedAt: OCCURRED,
            releasedAt: null,
            releaseReason: null,
            createdAt: OCCURRED,
            updatedAt: OCCURRED,
          });
        });

        const summary = await runInReadCommittedTransaction(
          database.pool,
          (tx) =>
            findSupplyPulseSummary(tx, {
              homeId,
              requesterMembershipId: alexB,
            }),
        );
        assert.deepEqual(summary, {
          openCount: 5,
          unclaimedOpenCount: 2,
          claimedByMeCount: 1,
        });
      } finally {
        await cleanup(database.pool, { userIds, homeIds });
        await database.close();
      }
    },
  );
});
