import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import type { AppConfig } from '../../platform/config/types.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import { listUserMembershipTenures } from './list-user-membership-tenures.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const ENDED_AT = new Date('2026-06-01T00:00:00.000Z');

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
    await pool.query('DELETE FROM homes WHERE id = ANY($1::uuid[])', [
      input.homeIds,
    ]);
  }
  if (input.userIds.length > 0) {
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
      input.userIds,
    ]);
  }
}

void describe('listUserMembershipTenures PostgreSQL', () => {
  void it(
    'returns ended, rejoin, and multi-Home tenures without collapsing history',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userId = randomUUID();
      const otherUser = randomUUID();
      const homeA = randomUUID();
      const homeB = randomUUID();
      const ended = randomUUID();
      const rejoin = randomUUID();
      const otherHome = randomUUID();
      const otherMembership = randomUUID();
      try {
        await database.pool.query(
          'INSERT INTO users (id, updated_at) VALUES ($1, NOW()), ($2, NOW())',
          [userId, otherUser],
        );
        await database.pool.query(
          `INSERT INTO homes (id, name, timezone, updated_at)
           VALUES ($1, 'A', 'UTC', NOW()), ($2, 'B', 'UTC', NOW())`,
          [homeA, homeB],
        );
        await database.pool.query(
          `INSERT INTO memberships (
             id, home_id, user_id, role, ended_at, ended_by_membership_id
           ) VALUES
             ($1, $3, $5, 'ROOMMATE', $7, $1),
             ($2, $3, $5, 'ROOMMATE', NULL, NULL),
             ($8, $4, $5, 'ADMIN', NULL, NULL),
             ($9, $3, $6, 'ADMIN', NULL, NULL)`,
          [
            ended,
            rejoin,
            homeA,
            homeB,
            userId,
            otherUser,
            ENDED_AT,
            otherHome,
            otherMembership,
          ],
        );
        const tenures = await runInReadCommittedTransaction(
          database.pool,
          (tx) => listUserMembershipTenures(tx, userId),
        );
        assert.equal(tenures.length, 3);
        assert.ok(tenures.some((tenure) => tenure.membershipId === ended));
        assert.ok(tenures.some((tenure) => tenure.membershipId === rejoin));
        assert.ok(tenures.some((tenure) => tenure.membershipId === otherHome));
        assert.equal(
          tenures
            .find((tenure) => tenure.membershipId === ended)
            ?.endedAt?.getTime(),
          ENDED_AT.getTime(),
        );
        assert.equal(
          tenures.find((tenure) => tenure.membershipId === rejoin)?.endedAt,
          null,
        );
        assert.equal(
          tenures.some((tenure) => tenure.membershipId === otherMembership),
          false,
        );
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeA, homeB],
          userIds: [userId, otherUser],
        });
        await database.close();
      }
    },
  );
});
