import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { isActorMembership } from '../../platform/authz/home-role.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import { resolveTestDatabaseUrl } from '../../platform/persistence/test-database.js';
import type { AppConfig } from '../../platform/config/types.js';
import { createActiveHomeActorResolver } from './active-home-actor-resolver.js';

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

void describe('ActiveHomeActorResolver PostgreSQL', () => {
  void it(
    'preserves current tenure identity across leave-and-rejoin',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(testConfig(resolveTestDatabaseUrl()));
      const userId = randomUUID();
      const homeId = randomUUID();
      const oldMembershipId = randomUUID();
      const newMembershipId = randomUUID();

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, { id: homeId, name: 'Rejoin Home' });
        await insertMembership(database.pool, {
          id: oldMembershipId,
          homeId,
          userId,
          role: 'ROOMMATE',
        });
        await database.pool.query(
          'UPDATE memberships SET ended_at = NOW() WHERE id = $1',
          [oldMembershipId],
        );
        await insertMembership(database.pool, {
          id: newMembershipId,
          homeId,
          userId,
          role: 'ADMIN',
        });

        const resolver = createActiveHomeActorResolver(database.pool);
        const actor = await resolver.resolve({ userId, homeId });

        assert.ok(actor);
        assert.equal(actor.membershipId, newMembershipId);
        assert.notEqual(actor.membershipId, oldMembershipId);
        assert.equal(isActorMembership(actor, oldMembershipId), false);
        assert.equal(isActorMembership(actor, newMembershipId), true);
        assert.equal(actor.userId, userId);
        assert.equal(actor.homeId, homeId);
        assert.equal(actor.role, 'ADMIN');
      } finally {
        await database.pool.query(
          'DELETE FROM memberships WHERE id = ANY($1)',
          [[oldMembershipId, newMembershipId]],
        );
        await database.pool.query('DELETE FROM homes WHERE id = $1', [homeId]);
        await database.pool.query('DELETE FROM users WHERE id = $1', [userId]);
        await database.close();
      }
    },
  );

  void it(
    'returns null for ended, archived, and unknown Homes without distinguishing them',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(testConfig(resolveTestDatabaseUrl()));
      const userId = randomUUID();
      const endedHomeId = randomUUID();
      const archivedHomeId = randomUUID();
      const unknownHomeId = randomUUID();
      const endedMembershipId = randomUUID();
      const archivedMembershipId = randomUUID();

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, { id: endedHomeId, name: 'Ended' });
        await insertHome(database.pool, {
          id: archivedHomeId,
          name: 'Archived',
          archived: true,
        });
        await insertMembership(database.pool, {
          id: endedMembershipId,
          homeId: endedHomeId,
          userId,
          role: 'ROOMMATE',
          ended: true,
        });
        await insertMembership(database.pool, {
          id: archivedMembershipId,
          homeId: archivedHomeId,
          userId,
          role: 'ROOMMATE',
        });

        const resolver = createActiveHomeActorResolver(database.pool);
        const [ended, archived, unknown] = await Promise.all([
          resolver.resolve({ userId, homeId: endedHomeId }),
          resolver.resolve({ userId, homeId: archivedHomeId }),
          resolver.resolve({ userId, homeId: unknownHomeId }),
        ]);

        assert.equal(ended, null);
        assert.equal(archived, null);
        assert.equal(unknown, null);
      } finally {
        await database.pool.query(
          'DELETE FROM memberships WHERE id = ANY($1)',
          [[endedMembershipId, archivedMembershipId]],
        );
        await database.pool.query('DELETE FROM homes WHERE id = ANY($1)', [
          [endedHomeId, archivedHomeId],
        ]);
        await database.pool.query('DELETE FROM users WHERE id = $1', [userId]);
        await database.close();
      }
    },
  );
});
