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
import { findMaintenancePulseSummary } from './find-maintenance-pulse-summary.js';
import {
  createMaintenanceRepository,
  type NewMaintenanceEntry,
} from './repository.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const CREATED = new Date('2026-09-13T12:00:00.000Z');

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
     VALUES ($1, 'Pulse Maintenance', 'UTC', NULL, NOW())`,
    [id],
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
    `INSERT INTO memberships (id, home_id, user_id, role, ended_at, ended_by_membership_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.id,
      input.homeId,
      input.userId,
      input.role,
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
    await pool.query(
      'DELETE FROM maintenance_audiences WHERE home_id = ANY($1)',
      [input.homeIds],
    );
    await pool.query(
      'DELETE FROM maintenance_entries WHERE home_id = ANY($1)',
      [input.homeIds],
    );
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

function entry(
  id: string,
  homeId: string,
  createdByMembershipId: string,
  visibility: 'HOUSEHOLD' | 'PRIVATE',
  title: string,
  status: 'OPEN' | 'RESOLVED' = 'OPEN',
): NewMaintenanceEntry {
  return {
    id,
    homeId,
    createdByMembershipId,
    visibility,
    title,
    details: `${title} details`,
    status,
    resolvedByMembershipId:
      status === 'RESOLVED' ? createdByMembershipId : null,
    resolvedAt: status === 'RESOLVED' ? CREATED : null,
    createdAt: CREATED,
    updatedAt: CREATED,
  };
}

void describe('findMaintenancePulseSummary PostgreSQL', () => {
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
    'counts only currently visible OPEN Maintenance for exact Membership',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const databaseUrl = resolveSafeDedicatedTestDatabaseUrl();
      const database = createDatabasePool(testConfig(databaseUrl));
      const maintenance = createMaintenanceRepository(database.pool);
      const userIds: string[] = [];
      const homeIds: string[] = [];
      const logs: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        logs.push(args.map((value) => JSON.stringify(value)).join(' '));
      };

      try {
        const homeId = createUuidV7();
        const alexUser = createUuidV7();
        const jamieUser = createUuidV7();
        const taylorUser = createUuidV7();
        const alexA = createUuidV7();
        const alexB = createUuidV7();
        const jamie = createUuidV7();
        const taylor = createUuidV7();
        homeIds.push(homeId);
        userIds.push(alexUser, jamieUser, taylorUser);

        await insertUser(database.pool, alexUser);
        await insertUser(database.pool, jamieUser);
        await insertUser(database.pool, taylorUser);
        await insertHome(database.pool, homeId);
        await insertMembership(database.pool, {
          id: alexA,
          homeId,
          userId: alexUser,
          role: 'ROOMMATE',
          ended: true,
        });
        await insertMembership(database.pool, {
          id: alexB,
          homeId,
          userId: alexUser,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: jamie,
          homeId,
          userId: jamieUser,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: taylor,
          homeId,
          userId: taylorUser,
          role: 'ADMIN',
        });

        const empty = await runInReadCommittedTransaction(database.pool, (tx) =>
          findMaintenancePulseSummary(tx, {
            homeId,
            requesterMembershipId: alexB,
          }),
        );
        assert.deepEqual(empty, { openVisibleCount: 0 });

        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await maintenance.insertEntryWithAudience(tx, {
            entry: entry(createUuidV7(), homeId, taylor, 'HOUSEHOLD', 'H1'),
            audienceMembershipIds: [],
          });
          await maintenance.insertEntryWithAudience(tx, {
            entry: entry(
              createUuidV7(),
              homeId,
              taylor,
              'HOUSEHOLD',
              'H-RESOLVED',
              'RESOLVED',
            ),
            audienceMembershipIds: [],
          });
          await maintenance.insertEntryWithAudience(tx, {
            entry: entry(createUuidV7(), homeId, alexB, 'PRIVATE', 'B1'),
            audienceMembershipIds: [alexB],
          });
          await maintenance.insertEntryWithAudience(tx, {
            entry: entry(createUuidV7(), homeId, jamie, 'PRIVATE', 'J1'),
            audienceMembershipIds: [jamie],
          });
          await maintenance.insertEntryWithAudience(tx, {
            entry: entry(
              createUuidV7(),
              homeId,
              jamie,
              'PRIVATE',
              'J-RESOLVED',
              'RESOLVED',
            ),
            audienceMembershipIds: [jamie],
          });
          await maintenance.insertEntryWithAudience(tx, {
            entry: entry(createUuidV7(), homeId, alexA, 'PRIVATE', 'A1-ENDED'),
            audienceMembershipIds: [alexA],
          });
        });

        const alex = await runInReadCommittedTransaction(database.pool, (tx) =>
          findMaintenancePulseSummary(tx, {
            homeId,
            requesterMembershipId: alexB,
          }),
        );
        const jamieCount = await runInReadCommittedTransaction(
          database.pool,
          (tx) =>
            findMaintenancePulseSummary(tx, {
              homeId,
              requesterMembershipId: jamie,
            }),
        );
        const taylorCount = await runInReadCommittedTransaction(
          database.pool,
          (tx) =>
            findMaintenancePulseSummary(tx, {
              homeId,
              requesterMembershipId: taylor,
            }),
        );
        assert.deepEqual(alex, { openVisibleCount: 2 });
        assert.deepEqual(jamieCount, { openVisibleCount: 2 });
        assert.deepEqual(taylorCount, { openVisibleCount: 1 });

        await runInReadCommittedTransaction(database.pool, async (tx) => {
          for (let index = 0; index < 8; index += 1) {
            await maintenance.insertEntryWithAudience(tx, {
              entry: entry(
                createUuidV7(),
                homeId,
                jamie,
                'PRIVATE',
                `HIDDEN-PRIVATE-JAMIE-${index}`,
              ),
              audienceMembershipIds: [jamie],
            });
          }
        });

        const alexAfter = await runInReadCommittedTransaction(
          database.pool,
          (tx) =>
            findMaintenancePulseSummary(tx, {
              homeId,
              requesterMembershipId: alexB,
            }),
        );
        const taylorAfter = await runInReadCommittedTransaction(
          database.pool,
          (tx) =>
            findMaintenancePulseSummary(tx, {
              homeId,
              requesterMembershipId: taylor,
            }),
        );
        assert.deepEqual(alexAfter, alex);
        assert.deepEqual(taylorAfter, taylorCount);
        assert.equal(
          logs.some((line) => line.includes('HIDDEN-PRIVATE-JAMIE')),
          false,
        );
        assert.equal(JSON.stringify(alexAfter).includes('HIDDEN'), false);
        assert.equal(JSON.stringify(alexAfter).includes('details'), false);
      } finally {
        console.error = originalError;
        await cleanup(database.pool, { userIds, homeIds });
        await database.close();
      }
    },
  );
});
