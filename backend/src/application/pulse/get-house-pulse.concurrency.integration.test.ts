import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { findHousePulseSnapshot } from '../../domains/homes/find-house-pulse-snapshot.js';
import {
  createMaintenanceRepository,
  type NewMaintenanceEntry,
} from '../../domains/maintenance/repository.js';
import { findMaintenancePulseSummary } from '../../domains/maintenance/find-maintenance-pulse-summary.js';
import { findSupplyPulseSummary } from '../../domains/supplies/find-supply-pulse-summary.js';
import { createSupplyRepository } from '../../domains/supplies/repository.js';
import { findTaskPulseSummary } from '../../domains/tasks/find-task-pulse-summary.js';
import { parseHomeLocalDate } from '../../domains/tasks/home-local-date.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import type { AppConfig } from '../../platform/config/types.js';
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import {
  runInReadCommittedTransaction,
  runInRepeatableReadTransaction,
} from '../../platform/persistence/transaction.js';
import {
  createGetHousePulseFromPool,
  getHousePulse,
} from './get-house-pulse.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const OCCURRED = new Date('2026-09-13T12:00:00.000Z');

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
     VALUES ($1, 'Pulse Snapshot', 'UTC', NULL, NOW())`,
    [id],
  );
}

async function insertMembership(
  pool: Pool,
  input: { id: string; homeId: string; userId: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO memberships (id, home_id, user_id, role, ended_at, ended_by_membership_id)
     VALUES ($1, $2, $3, 'ROOMMATE', NULL, NULL)`,
    [input.id, input.homeId, input.userId],
  );
}

async function cleanup(
  pool: Pool,
  input: { userIds: string[]; homeIds: string[] },
): Promise<void> {
  if (input.homeIds.length > 0) {
    await pool.query(
      'DELETE FROM notifications WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query(
      'DELETE FROM activity_recipients WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query('DELETE FROM activities WHERE home_id = ANY($1::uuid[])', [
      input.homeIds,
    ]);
    await pool.query('DELETE FROM supply_claims WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query('DELETE FROM supply_entries WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query(
      'DELETE FROM maintenance_audiences WHERE home_id = ANY($1)',
      [input.homeIds],
    );
    await pool.query(
      'DELETE FROM maintenance_entries WHERE home_id = ANY($1)',
      [input.homeIds],
    );
    await pool.query('DELETE FROM task_instances WHERE home_id = ANY($1)', [
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

function entry(
  id: string,
  homeId: string,
  createdByMembershipId: string,
): NewMaintenanceEntry {
  return {
    id,
    homeId,
    createdByMembershipId,
    visibility: 'HOUSEHOLD',
    title: 'Visible household',
    details: 'Visible household details',
    status: 'OPEN',
    resolvedByMembershipId: null,
    resolvedAt: null,
    createdAt: OCCURRED,
    updatedAt: OCCURRED,
  };
}

void describe('getHousePulse REPEATABLE READ snapshot PostgreSQL', () => {
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
    'keeps later Pulse sections on the original snapshot after concurrent writes',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const databaseUrl = resolveSafeDedicatedTestDatabaseUrl();
      const database = createDatabasePool(testConfig(databaseUrl));
      const supplies = createSupplyRepository(database.pool);
      const maintenance = createMaintenanceRepository(database.pool);
      const userIds: string[] = [];
      const homeIds: string[] = [];

      try {
        const homeId = createUuidV7();
        const userId = createUuidV7();
        const membershipId = createUuidV7();
        const supplyId = createUuidV7();
        const maintenanceId = createUuidV7();
        homeIds.push(homeId);
        userIds.push(userId);

        await insertUser(database.pool, userId);
        await insertHome(database.pool, homeId);
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
        });
        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await supplies.insertSupplyEntry(tx, {
            id: supplyId,
            homeId,
            title: 'Milk',
            status: 'OPEN',
            createdByMembershipId: membershipId,
            obtainedAt: null,
            obtainedByMembershipId: null,
            canceledAt: null,
            createdAt: OCCURRED,
            updatedAt: OCCURRED,
          });
          await maintenance.insertEntryWithAudience(tx, {
            entry: entry(maintenanceId, homeId, membershipId),
            audienceMembershipIds: [],
          });
        });

        const requester: ActiveHomeActor = {
          userId,
          membershipId,
          homeId,
          role: 'ROOMMATE',
        };

        let releaseWriter!: () => void;
        const writerMayStart = new Promise<void>((resolve) => {
          releaseWriter = resolve;
        });
        let writerFinished!: () => void;
        const writerCommitted = new Promise<void>((resolve) => {
          writerFinished = resolve;
        });

        const pulsePromise = getHousePulse(
          { actor: requester, homeId },
          {
            snapshot: { findHousePulseSnapshot },
            tasks: { findTaskPulseSummary },
            supplies: { findSupplyPulseSummary },
            maintenance: { findMaintenancePulseSummary },
            runRepeatableRead: (work) =>
              runInRepeatableReadTransaction(database.pool, work),
            afterTaskSummary: async (tx) => {
              const isolation = await tx.query<{
                transaction_isolation: string;
              }>('SHOW transaction_isolation');
              assert.equal(
                isolation.rows[0]?.transaction_isolation,
                'repeatable read',
              );
              releaseWriter();
              await writerCommitted;
            },
          },
        );

        await writerMayStart;
        await runInReadCommittedTransaction(database.pool, async (tx) => {
          const obtained = await supplies.terminalizeSupplyEntryAsObtained(tx, {
            supplyEntryId: supplyId,
            homeId,
            obtainedAt: new Date(),
            obtainedByMembershipId: membershipId,
          });
          assert.ok(obtained);
          const resolved = await maintenance.resolveOpenEntry(tx, {
            homeId,
            maintenanceEntryId: maintenanceId,
            resolverMembershipId: membershipId,
            resolvedAt: new Date(),
          });
          assert.ok(resolved);
        });
        writerFinished();

        const snapshotPulse = await pulsePromise;
        assert.equal(snapshotPulse.items[1]?.openCount, 1);
        assert.equal(snapshotPulse.items[1]?.unclaimedOpenCount, 1);
        assert.equal(snapshotPulse.items[2]?.openVisibleCount, 1);
        assert.equal(snapshotPulse.items[1]?.state, 'ACTIVE');
        assert.equal(snapshotPulse.items[2]?.state, 'ACTIVE');

        const later = await createGetHousePulseFromPool(database.pool)({
          actor: requester,
          homeId,
        });
        assert.equal(later.items[1]?.openCount, 0);
        assert.equal(later.items[2]?.openVisibleCount, 0);
        assert.equal(later.items[1]?.state, 'CLEAR');
        assert.equal(later.items[2]?.state, 'CLEAR');
        assert.equal(
          parseHomeLocalDate(later.homeLocalDate),
          later.homeLocalDate,
        );
      } finally {
        await cleanup(database.pool, { userIds, homeIds });
        await database.close();
      }
    },
  );
});
