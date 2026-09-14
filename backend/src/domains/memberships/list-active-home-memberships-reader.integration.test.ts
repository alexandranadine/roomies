import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import { resolveTestDatabaseUrl } from '../../platform/persistence/test-database.js';
import type { AppConfig } from '../../platform/config/types.js';
import {
  createActiveHomeMembershipsReader,
  LIST_ACTIVE_HOME_MEMBERSHIPS_SQL,
} from './list-active-home-memberships-reader.js';

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
     VALUES ($1, $2, $3, false)`,
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

void describe('list active Home Memberships PostgreSQL', () => {
  void it(
    'returns only current tenures ordered by name then membershipId',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(testConfig(resolveTestDatabaseUrl()));
      const homeA = randomUUID();
      const homeB = randomUUID();
      const alex = randomUUID();
      const jamie = randomUUID();
      const casey = randomUUID();
      const drew = randomUUID();
      const sam = randomUUID();
      const taylor = randomUUID();
      const external = randomUUID();
      const membershipAlex = randomUUID();
      const membershipJamie = randomUUID();
      const membershipCasey = randomUUID();
      const membershipDrewEnded = randomUUID();
      const membershipSamEnded = randomUUID();
      const membershipSamActive = randomUUID();
      const membershipTaylor = randomUUID();
      const identityIds = [alex, jamie, casey, drew, sam, taylor, external];

      try {
        const suffix = randomUUID();
        await insertIdentity(database.pool, {
          id: alex,
          name: 'Alex',
          email: `alex-${suffix}@example.test`,
        });
        await insertIdentity(database.pool, {
          id: jamie,
          name: 'Jamie',
          email: `jamie-${suffix}@example.test`,
        });
        await insertIdentity(database.pool, {
          id: casey,
          name: 'Casey',
          email: `casey-${suffix}@example.test`,
        });
        await insertIdentity(database.pool, {
          id: drew,
          name: 'Drew',
          email: `drew-${suffix}@example.test`,
        });
        await insertIdentity(database.pool, {
          id: sam,
          name: 'Sam',
          email: `sam-${suffix}@example.test`,
        });
        await insertIdentity(database.pool, {
          id: taylor,
          name: 'Taylor',
          email: `taylor-${suffix}@example.test`,
        });
        await insertIdentity(database.pool, {
          id: external,
          name: 'External Contact',
          email: `external-${suffix}@example.test`,
        });

        await insertHome(database.pool, { id: homeA, name: 'Home A' });
        await insertHome(database.pool, { id: homeB, name: 'Home B' });

        await insertMembership(database.pool, {
          id: membershipAlex,
          homeId: homeA,
          userId: alex,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: membershipJamie,
          homeId: homeA,
          userId: jamie,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: membershipCasey,
          homeId: homeA,
          userId: casey,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipDrewEnded,
          homeId: homeA,
          userId: drew,
          role: 'ROOMMATE',
          ended: true,
        });
        await insertMembership(database.pool, {
          id: membershipSamEnded,
          homeId: homeA,
          userId: sam,
          role: 'ROOMMATE',
          ended: true,
        });
        await insertMembership(database.pool, {
          id: membershipSamActive,
          homeId: homeA,
          userId: sam,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipTaylor,
          homeId: homeB,
          userId: taylor,
          role: 'ROOMMATE',
        });

        assert.match(LIST_ACTIVE_HOME_MEMBERSHIPS_SQL, /m\.ended_at IS NULL/);

        const reader = createActiveHomeMembershipsReader(database.pool);
        const listed = await reader.listActiveByHome(homeA);
        assert.deepEqual(
          listed.map((row) => row.name),
          ['Alex', 'Casey', 'Jamie', 'Sam'],
        );
        assert.deepEqual(
          listed.map((row) => row.membershipId),
          [
            membershipAlex,
            membershipCasey,
            membershipJamie,
            membershipSamActive,
          ],
        );
        assert.equal(
          listed.some((row) => row.membershipId === membershipSamEnded),
          false,
        );
        assert.equal(
          listed.some((row) => row.membershipId === membershipDrewEnded),
          false,
        );
        assert.equal(
          listed.some((row) => row.membershipId === membershipTaylor),
          false,
        );
        assert.equal(
          listed.some((row) => row.name === 'External Contact'),
          false,
        );
        assert.equal(
          listed.some((row) => row.name === 'Taylor'),
          false,
        );
        assert.equal('userId' in listed[0]!, false);
        assert.equal('email' in listed[0]!, false);
        assert.equal('role' in listed[0]!, false);

        const homeBList = await reader.listActiveByHome(homeB);
        assert.deepEqual(homeBList, [
          { membershipId: membershipTaylor, name: 'Taylor' },
        ]);
      } finally {
        await database.pool.query(
          `UPDATE memberships
           SET ended_by_membership_id = id
           WHERE home_id = ANY($1::uuid[]) AND ended_at IS NOT NULL`,
          [[homeA, homeB]],
        );
        await database.pool.query(
          `DELETE FROM memberships
           WHERE home_id = ANY($1::uuid[]) AND ended_at IS NULL`,
          [[homeA, homeB]],
        );
        await database.pool.query(
          `UPDATE memberships
           SET ended_at = NULL, ended_by_membership_id = NULL
           WHERE home_id = ANY($1::uuid[])`,
          [[homeA, homeB]],
        );
        await database.pool.query(
          'DELETE FROM memberships WHERE home_id = ANY($1::uuid[])',
          [[homeA, homeB]],
        );
        await database.pool.query(
          'DELETE FROM homes WHERE id = ANY($1::uuid[])',
          [[homeA, homeB]],
        );
        await database.pool.query(
          'DELETE FROM auth_identities WHERE id = ANY($1::uuid[])',
          [identityIds],
        );
        await database.pool.query(
          'DELETE FROM users WHERE id = ANY($1::uuid[])',
          [identityIds],
        );
        await database.close();
      }
    },
  );
});
