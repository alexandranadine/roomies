import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import { resolveTestDatabaseUrl } from '../../platform/persistence/test-database.js';
import type { AppConfig } from '../../platform/config/types.js';
import { listActiveHomesForUser } from './list-active-homes.js';
import { createActiveHomesForUserReader } from './repository/active-homes-for-user.js';

const skipWithoutDatabase =
  !process.env['TEST_DATABASE_URL'] && !process.env['DATABASE_URL']
    ? 'requires a migrated PostgreSQL test database'
    : false;

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

async function insertHome(
  pool: Pool,
  input: { id: string; name: string; timezone: string; archived?: boolean },
): Promise<void> {
  await pool.query(
    `INSERT INTO homes (id, name, timezone, archived_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [
      input.id,
      input.name,
      input.timezone,
      input.archived === true ? new Date() : null,
    ],
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

void describe('listActiveHomesForUser PostgreSQL', () => {
  void it(
    'discovers only current unarchived Homes for the canonical User',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(testConfig(resolveTestDatabaseUrl()));
      const userId = randomUUID();
      const zeroUserId = randomUUID();
      const otherUserId = randomUUID();
      const cedarId = randomUUID();
      const oakId = randomUUID();
      const zebraId = randomUUID();
      const archivedId = randomUUID();
      const otherHomeId = randomUUID();
      const formerHomeId = randomUUID();
      const membershipIds = [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ];
      const homeIds = [
        cedarId,
        oakId,
        zebraId,
        archivedId,
        otherHomeId,
        formerHomeId,
      ];

      try {
        await insertUser(database.pool, userId);
        await insertUser(database.pool, zeroUserId);
        await insertUser(database.pool, otherUserId);

        await insertHome(database.pool, {
          id: oakId,
          name: 'Oak Street',
          timezone: 'America/Los_Angeles',
        });
        await insertHome(database.pool, {
          id: cedarId,
          name: 'Cedar House',
          timezone: 'UTC',
        });
        await insertHome(database.pool, {
          id: zebraId,
          name: 'Zebra Loft',
          timezone: 'UTC',
        });
        await insertHome(database.pool, {
          id: archivedId,
          name: 'Archived Place',
          timezone: 'UTC',
          archived: true,
        });
        await insertHome(database.pool, {
          id: otherHomeId,
          name: 'Another User Home',
          timezone: 'UTC',
        });
        await insertHome(database.pool, {
          id: formerHomeId,
          name: 'Former Tenure',
          timezone: 'UTC',
        });

        await insertMembership(database.pool, {
          id: membershipIds[0]!,
          homeId: oakId,
          userId,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipIds[1]!,
          homeId: cedarId,
          userId,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: membershipIds[2]!,
          homeId: zebraId,
          userId,
          role: 'ROOMMATE',
          ended: true,
        });
        await insertMembership(database.pool, {
          id: membershipIds[3]!,
          homeId: archivedId,
          userId,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: membershipIds[4]!,
          homeId: otherHomeId,
          userId: otherUserId,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipIds[5]!,
          homeId: formerHomeId,
          userId,
          role: 'ROOMMATE',
          ended: true,
        });

        const reader = createActiveHomesForUserReader(database.pool);

        const zeroHomes = await listActiveHomesForUser(
          { userId: zeroUserId },
          reader,
        );
        assert.deepEqual(zeroHomes, []);

        const discovered = await listActiveHomesForUser({ userId }, reader);
        assert.deepEqual(
          discovered.map((home) => ({
            id: home.id,
            name: home.name,
            timezone: home.timezone,
            role: home.role,
          })),
          [
            {
              id: cedarId,
              name: 'Cedar House',
              timezone: 'UTC',
              role: 'ROOMMATE',
            },
            {
              id: oakId,
              name: 'Oak Street',
              timezone: 'America/Los_Angeles',
              role: 'ADMIN',
            },
          ],
        );
        assert.equal(
          discovered.some((home) => home.id === zebraId),
          false,
        );
        assert.equal(
          discovered.some((home) => home.id === archivedId),
          false,
        );
        assert.equal(
          discovered.some((home) => home.id === otherHomeId),
          false,
        );
        assert.equal(
          discovered.some((home) => home.id === formerHomeId),
          false,
        );
        assert.equal(discovered.length, 2);

        const serialized = JSON.stringify(discovered);
        assert.equal(serialized.includes(membershipIds[0]!), false);
        assert.equal(serialized.includes('ended'), false);
        assert.equal(serialized.includes('archived'), false);
        assert.equal(serialized.includes('invitation'), false);

        await insertMembership(database.pool, {
          id: membershipIds[6]!,
          homeId: formerHomeId,
          userId,
          role: 'ADMIN',
        });
        const afterRejoin = await listActiveHomesForUser({ userId }, reader);
        assert.deepEqual(
          afterRejoin.map((home) => ({ id: home.id, role: home.role })),
          [
            { id: cedarId, role: 'ROOMMATE' },
            { id: formerHomeId, role: 'ADMIN' },
            { id: oakId, role: 'ADMIN' },
          ],
        );
        assert.equal(
          afterRejoin.filter((home) => home.id === formerHomeId).length,
          1,
        );

        const otherUserHomes = await listActiveHomesForUser(
          { userId: otherUserId },
          reader,
        );
        assert.deepEqual(
          otherUserHomes.map((home) => home.id),
          [otherHomeId],
        );
      } finally {
        await database.pool.query(
          'DELETE FROM memberships WHERE id = ANY($1)',
          [membershipIds],
        );
        await database.pool.query('DELETE FROM homes WHERE id = ANY($1)', [
          homeIds,
        ]);
        await database.pool.query('DELETE FROM users WHERE id = ANY($1)', [
          [userId, zeroUserId, otherUserId],
        ]);
        await database.close();
      }
    },
  );
});
