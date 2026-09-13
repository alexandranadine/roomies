import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { insertHome } from '../../domains/homes/insert-home.js';
import { evaluateHomeStructureInvariant } from '../../domains/homes/structure-invariant.js';
import { TransactionInfrastructureError } from '../../platform/persistence/errors.js';
import type { AppConfig } from '../../platform/config/types.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import { systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createCreateHome, createCreateHomeFromPool } from './create-home.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OCCURRED_AT = new Date('2026-09-12T18:00:00.000Z');

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

async function cleanup(
  pool: Pool,
  input: { userIds: string[]; homeIds: string[] },
): Promise<void> {
  if (input.homeIds.length > 0) {
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

type HomeRow = {
  id: string;
  name: string;
  timezone: string;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type MembershipRow = {
  id: string;
  home_id: string;
  user_id: string;
  role: string;
  joined_at: Date;
  ended_at: Date | null;
};

void describe('createCreateHome PostgreSQL', () => {
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
    'persists Home + founding ADMIN Membership without Owner fields or events',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userId = randomUUID();
      const homeIds: string[] = [];
      const create = createCreateHomeFromPool(database.pool);

      try {
        await insertUser(database.pool, userId);
        const first = await create({
          userId,
          name: '  Oak Street  ',
          timezone: 'America/Los_Angeles',
        });
        homeIds.push(first.home.id);
        assert.match(first.home.id, UUID_V7);
        assert.match(first.membership.id, UUID_V7);
        assert.equal(first.home.name, 'Oak Street');
        assert.equal(first.home.timezone, 'America/Los_Angeles');
        assert.equal(first.membership.role, 'ADMIN');

        const home = await database.pool.query<HomeRow>(
          `SELECT id, name, timezone, archived_at, created_at, updated_at
           FROM homes WHERE id = $1`,
          [first.home.id],
        );
        assert.equal(home.rowCount, 1);
        assert.equal(home.rows[0]?.name, 'Oak Street');
        assert.equal(home.rows[0]?.timezone, 'America/Los_Angeles');
        assert.equal(home.rows[0]?.archived_at, null);
        assert.deepEqual(
          Object.keys(home.rows[0] ?? {}).sort(),
          [
            'archived_at',
            'created_at',
            'id',
            'name',
            'timezone',
            'updated_at',
          ].sort(),
        );

        const memberships = await database.pool.query<MembershipRow>(
          `SELECT id, home_id, user_id, role, joined_at, ended_at
           FROM memberships WHERE home_id = $1`,
          [first.home.id],
        );
        assert.equal(memberships.rowCount, 1);
        assert.equal(memberships.rows[0]?.id, first.membership.id);
        assert.equal(memberships.rows[0]?.home_id, first.home.id);
        assert.equal(memberships.rows[0]?.user_id, userId);
        assert.equal(memberships.rows[0]?.role, 'ADMIN');
        assert.equal(memberships.rows[0]?.ended_at, null);
        assert.equal(
          memberships.rows[0]?.joined_at.valueOf(),
          home.rows[0]?.created_at.valueOf(),
        );

        const invariant = evaluateHomeStructureInvariant({
          archived: false,
          activeMemberships: memberships.rows.map((row) => ({
            role: row.role === 'ADMIN' ? 'ADMIN' : 'ROOMMATE',
          })),
        });
        assert.equal(invariant.ok, true);

        const second = await create({
          userId,
          name: 'Oak Street',
          timezone: 'UTC',
        });
        homeIds.push(second.home.id);
        assert.notEqual(second.home.id, first.home.id);
        assert.notEqual(second.membership.id, first.membership.id);
        assert.equal(second.membership.role, 'ADMIN');

        const userMemberships = await database.pool.query<{
          home_id: string;
          role: string;
          ended_at: Date | null;
        }>(
          `SELECT home_id, role, ended_at FROM memberships WHERE user_id = $1
           ORDER BY home_id`,
          [userId],
        );
        assert.equal(userMemberships.rowCount, 2);
        assert.deepEqual(
          new Set(userMemberships.rows.map((row) => row.home_id)),
          new Set(homeIds),
        );
        assert.ok(userMemberships.rows.every((row) => row.role === 'ADMIN'));
        assert.ok(userMemberships.rows.every((row) => row.ended_at === null));

        const events = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM outbox_events WHERE home_id = ANY($1)`,
          [homeIds],
        );
        assert.equal(events.rows[0]?.count, '0');

        const homeColumns = await database.pool.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'homes'`,
        );
        const membershipColumns = await database.pool.query<{
          column_name: string;
        }>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'memberships'`,
        );
        const userColumns = await database.pool.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'users'`,
        );
        const forbidden = [
          'owner_id',
          'ownerid',
          'created_by_user_id',
          'createdbyuserid',
          'primary_admin',
          'primaryadmin',
          'founder',
          'current_home_id',
          'currenthomeid',
        ];
        for (const column of [
          ...homeColumns.rows,
          ...membershipColumns.rows,
          ...userColumns.rows,
        ]) {
          assert.equal(
            forbidden.includes(column.column_name.toLowerCase()),
            false,
          );
        }
      } finally {
        await cleanup(database.pool, { userIds: [userId], homeIds });
        await database.close();
      }
    },
  );

  void it(
    'rolls back the Home when Membership insert fails and leaves no orphans',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userId = randomUUID();
      const homeId = systemUuidV7.next();
      const membershipId = systemUuidV7.next();
      const remainingIds = [homeId, membershipId];
      const create = createCreateHome({
        runTransaction: (work) =>
          runInReadCommittedTransaction(database.pool, work),
        insertHome,
        insertMembership: () =>
          Promise.reject(new TransactionInfrastructureError()),
        clock: { now: () => OCCURRED_AT },
        ids: {
          next() {
            const id = remainingIds.shift();
            if (id === undefined) {
              throw new Error('unexpected extra id');
            }
            return id;
          },
        },
      });

      try {
        await insertUser(database.pool, userId);
        await assert.rejects(
          create({
            userId,
            name: 'Rollback Home',
            timezone: 'UTC',
          }),
          TransactionInfrastructureError,
        );

        const homes = await database.pool.query(
          'SELECT id FROM homes WHERE id = $1',
          [homeId],
        );
        const memberships = await database.pool.query(
          'SELECT id FROM memberships WHERE id = $1 OR home_id = $2',
          [membershipId, homeId],
        );
        assert.equal(homes.rowCount, 0);
        assert.equal(memberships.rowCount, 0);
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
    'allows two concurrent creates by the same User with distinct IDs',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userId = randomUUID();
      const create = createCreateHomeFromPool(database.pool);
      const homeIds: string[] = [];

      try {
        await insertUser(database.pool, userId);
        const [left, right] = await Promise.all([
          create({
            userId,
            name: 'Concurrent A',
            timezone: 'America/Los_Angeles',
          }),
          create({
            userId,
            name: 'Concurrent B',
            timezone: 'America/New_York',
          }),
        ]);
        homeIds.push(left.home.id, right.home.id);

        assert.notEqual(left.home.id, right.home.id);
        assert.notEqual(left.membership.id, right.membership.id);
        assert.match(left.home.id, UUID_V7);
        assert.match(right.home.id, UUID_V7);
        assert.match(left.membership.id, UUID_V7);
        assert.match(right.membership.id, UUID_V7);
        assert.equal(left.membership.role, 'ADMIN');
        assert.equal(right.membership.role, 'ADMIN');
        assert.notEqual(left.membership.id, left.home.id);
        assert.notEqual(right.membership.id, right.home.id);
        assert.notEqual(left.membership.id, right.home.id);
        assert.notEqual(right.membership.id, left.home.id);

        const rows = await database.pool.query<MembershipRow>(
          `SELECT id, home_id, user_id, role, joined_at, ended_at
           FROM memberships WHERE home_id = ANY($1) ORDER BY home_id`,
          [homeIds],
        );
        assert.equal(rows.rowCount, 2);
        const byHome = new Map(rows.rows.map((row) => [row.home_id, row]));
        const leftRow = byHome.get(left.home.id);
        const rightRow = byHome.get(right.home.id);
        assert.ok(leftRow);
        assert.ok(rightRow);
        assert.equal(leftRow.id, left.membership.id);
        assert.equal(rightRow.id, right.membership.id);
        assert.equal(leftRow.user_id, userId);
        assert.equal(rightRow.user_id, userId);
        assert.equal(leftRow.role, 'ADMIN');
        assert.equal(rightRow.role, 'ADMIN');
        assert.equal(leftRow.ended_at, null);
        assert.equal(rightRow.ended_at, null);
        assert.equal(leftRow.home_id, left.home.id);
        assert.equal(rightRow.home_id, right.home.id);
      } finally {
        await cleanup(database.pool, { userIds: [userId], homeIds });
        await database.close();
      }
    },
  );
});
