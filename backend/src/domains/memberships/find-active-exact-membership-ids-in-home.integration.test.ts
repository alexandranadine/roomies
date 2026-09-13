import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import type { AppConfig } from '../../platform/config/types.js';
import { AuthorizationIntegrityError } from '../../platform/authz/errors.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import {
  FIND_ACTIVE_EXACT_MEMBERSHIP_IDS_IN_HOME_SQL,
  findActiveExactMembershipIdsInHome,
} from './find-active-exact-membership-ids-in-home.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();

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
  input: { homeIds: string[]; userIds: string[] },
): Promise<void> {
  if (input.homeIds.length > 0) {
    await pool.query('DELETE FROM memberships WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query('DELETE FROM homes WHERE id = ANY($1)', [input.homeIds]);
  }
  if (input.userIds.length > 0) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [input.userIds]);
  }
}

void describe('findActiveExactMembershipIdsInHome PostgreSQL', () => {
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
    'returns only active exact same-Home Membership IDs',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const homeA = randomUUID();
      const homeB = randomUUID();
      const activeA = randomUUID();
      const endedA = randomUUID();
      const foreignB = randomUUID();
      const missing = randomUUID();

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, homeA, 'Home A');
        await insertHome(database.pool, homeB, 'Home B');
        await insertMembership(database.pool, {
          id: activeA,
          homeId: homeA,
          userId: userA,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: endedA,
          homeId: homeA,
          userId: userA,
          role: 'ROOMMATE',
          ended: true,
        });
        await insertMembership(database.pool, {
          id: foreignB,
          homeId: homeB,
          userId: userB,
          role: 'ADMIN',
        });

        const found = await runInReadCommittedTransaction(database.pool, (tx) =>
          findActiveExactMembershipIdsInHome(tx, {
            homeId: homeA,
            membershipIds: [endedA, foreignB, missing, activeA, activeA],
          }),
        );

        assert.deepEqual(found, [activeA]);
        assert.equal(found.includes(endedA), false);
        assert.equal(found.includes(foreignB), false);
        assert.equal(found.includes(missing), false);
        assert.match(
          FIND_ACTIVE_EXACT_MEMBERSHIP_IDS_IN_HOME_SQL,
          /m\.home_id = \$1::uuid/,
        );
        assert.doesNotMatch(
          FIND_ACTIVE_EXACT_MEMBERSHIP_IDS_IN_HOME_SQL,
          /FOR UPDATE/i,
        );
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeA, homeB],
          userIds: [userA, userB],
        });
        await database.close();
      }
    },
  );

  void it(
    'does not distinguish foreign, ended, or missing IDs',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userId = randomUUID();
      const homeId = randomUUID();
      const otherHome = randomUUID();
      const active = randomUUID();
      const ended = randomUUID();
      const foreign = randomUUID();
      const missing = randomUUID();

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, homeId, 'Conceal home');
        await insertHome(database.pool, otherHome, 'Other home');
        await insertMembership(database.pool, {
          id: active,
          homeId,
          userId,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: ended,
          homeId,
          userId,
          role: 'ROOMMATE',
          ended: true,
        });
        await insertMembership(database.pool, {
          id: foreign,
          homeId: otherHome,
          userId,
          role: 'ROOMMATE',
        });

        const [endedResult, foreignResult, missingResult] =
          await runInReadCommittedTransaction(database.pool, async (tx) => {
            const endedIds = await findActiveExactMembershipIdsInHome(tx, {
              homeId,
              membershipIds: [ended],
            });
            const foreignIds = await findActiveExactMembershipIdsInHome(tx, {
              homeId,
              membershipIds: [foreign],
            });
            const missingIds = await findActiveExactMembershipIdsInHome(tx, {
              homeId,
              membershipIds: [missing],
            });
            return [endedIds, foreignIds, missingIds] as const;
          });

        assert.deepEqual(endedResult, []);
        assert.deepEqual(foreignResult, []);
        assert.deepEqual(missingResult, []);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId, otherHome],
          userIds: [userId],
        });
        await database.close();
      }
    },
  );

  void it(
    'fails closed on a malformed requested Membership id',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      try {
        await assert.rejects(
          () =>
            runInReadCommittedTransaction(database.pool, (tx) =>
              findActiveExactMembershipIdsInHome(tx, {
                homeId: randomUUID(),
                membershipIds: ['not-a-uuid'],
              }),
            ),
          AuthorizationIntegrityError,
        );
      } finally {
        await database.close();
      }
    },
  );
});
