import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import type { AppConfig } from '../../platform/config/types.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import { resolveTestDatabaseUrl } from '../../platform/persistence/test-database.js';
import {
  FIND_HISTORICAL_MEMBERSHIP_DISPLAYS_SQL,
  findHistoricalMembershipDisplays,
} from './find-historical-membership-display.js';

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

async function insertIdentity(
  pool: Pool,
  input: { id: string; name: string; email: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO auth_identities (id, name, email, email_verified)
     VALUES ($1, $2, $3, true)`,
    [input.id, input.name, input.email],
  );
}

async function insertHome(
  pool: Pool,
  input: { id: string; name: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO homes (id, name, timezone, updated_at)
     VALUES ($1, $2, 'UTC', NOW())`,
    [input.id, input.name],
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
  input: { homeIds: string[]; userIds: string[] },
): Promise<void> {
  if (input.homeIds.length > 0) {
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
    await pool.query(
      `UPDATE memberships
       SET ended_at = NULL, ended_by_membership_id = NULL
       WHERE home_id = ANY($1::uuid[])`,
      [input.homeIds],
    );
    await pool.query(
      'DELETE FROM memberships WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query('DELETE FROM homes WHERE id = ANY($1::uuid[])', [
      input.homeIds,
    ]);
  }
  if (input.userIds.length > 0) {
    await pool.query('DELETE FROM auth_identities WHERE id = ANY($1::uuid[])', [
      input.userIds,
    ]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
      input.userIds,
    ]);
  }
}

void describe('findHistoricalMembershipDisplays PostgreSQL', () => {
  void it(
    'resolves current names for ended tenures and nulls after AuthIdentity removal',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(testConfig(resolveTestDatabaseUrl()));
      const homeA = randomUUID();
      const homeB = randomUUID();
      const alex = randomUUID();
      const jamie = randomUUID();
      const membershipAlexEnded = randomUUID();
      const membershipAlexRejoin = randomUUID();
      const membershipJamie = randomUUID();
      const membershipForeign = randomUUID();
      const suffix = randomUUID();

      try {
        assert.match(
          FIND_HISTORICAL_MEMBERSHIP_DISPLAYS_SQL,
          /LEFT JOIN auth_identities/,
        );
        assert.equal(
          FIND_HISTORICAL_MEMBERSHIP_DISPLAYS_SQL.includes('ended_at IS NULL'),
          false,
        );

        await insertIdentity(database.pool, {
          id: alex,
          name: 'Alex Rivera',
          email: `alex-${suffix}@example.test`,
        });
        await insertIdentity(database.pool, {
          id: jamie,
          name: 'Jamie Chen',
          email: `jamie-${suffix}@example.test`,
        });
        await insertHome(database.pool, { id: homeA, name: 'Attribution A' });
        await insertHome(database.pool, { id: homeB, name: 'Attribution B' });
        await insertMembership(database.pool, {
          id: membershipAlexEnded,
          homeId: homeA,
          userId: alex,
          role: 'ADMIN',
          ended: true,
        });
        await insertMembership(database.pool, {
          id: membershipAlexRejoin,
          homeId: homeA,
          userId: alex,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: membershipJamie,
          homeId: homeA,
          userId: jamie,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipForeign,
          homeId: homeB,
          userId: alex,
          role: 'ROOMMATE',
        });

        const whilePresent = await findHistoricalMembershipDisplays(
          database.pool,
          {
            homeId: homeA,
            membershipIds: [
              membershipAlexEnded,
              membershipAlexRejoin,
              membershipJamie,
              membershipForeign,
              randomUUID(),
            ],
          },
        );
        assert.equal(
          whilePresent.get(membershipAlexEnded)?.name,
          'Alex Rivera',
        );
        assert.equal(
          whilePresent.get(membershipAlexRejoin)?.name,
          'Alex Rivera',
        );
        assert.equal(whilePresent.get(membershipJamie)?.name, 'Jamie Chen');
        assert.equal(whilePresent.has(membershipForeign), false);
        assert.equal(whilePresent.size, 3);
        assert.equal(
          'userId' in (whilePresent.get(membershipAlexEnded) ?? {}),
          false,
        );
        assert.equal(
          'email' in (whilePresent.get(membershipAlexEnded) ?? {}),
          false,
        );
        assert.equal(
          'role' in (whilePresent.get(membershipAlexEnded) ?? {}),
          false,
        );

        await database.pool.query('DELETE FROM auth_identities WHERE id = $1', [
          alex,
        ]);

        const afterIdentityGone = await findHistoricalMembershipDisplays(
          database.pool,
          {
            homeId: homeA,
            membershipIds: [
              membershipAlexEnded,
              membershipAlexRejoin,
              membershipJamie,
            ],
          },
        );
        assert.equal(afterIdentityGone.get(membershipAlexEnded)?.name, null);
        assert.equal(afterIdentityGone.get(membershipAlexRejoin)?.name, null);
        assert.equal(
          afterIdentityGone.get(membershipAlexEnded)?.membershipId,
          membershipAlexEnded,
        );
        assert.equal(
          afterIdentityGone.get(membershipJamie)?.name,
          'Jamie Chen',
        );
        const deletedStillPresent = await database.pool.query<{
          deleted_at: Date | null;
        }>('SELECT deleted_at FROM users WHERE id = $1', [alex]);
        assert.equal(deletedStillPresent.rows[0]?.deleted_at, null);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeA, homeB],
          userIds: [alex, jamie],
        });
        await database.close();
      }
    },
  );
});
