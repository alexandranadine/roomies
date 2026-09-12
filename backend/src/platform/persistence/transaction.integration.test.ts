import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { createDatabasePool } from './pool.js';
import { resolveTestDatabaseUrl } from './test-database.js';
import type { AppConfig } from '../config/types.js';
import {
  runInReadCommittedTransaction,
  type TransactionContext,
} from './transaction.js';

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

async function insertHome(
  tx:
    Pick<TransactionContext, 'query'> | { query: TransactionContext['query'] },
  input: { id: string; name: string },
): Promise<void> {
  await tx.query(
    `INSERT INTO homes (id, name, timezone, updated_at)
     VALUES ($1, $2, 'UTC', NOW())`,
    [input.id, input.name],
  );
}

void describe('READ COMMITTED transaction runner PostgreSQL', () => {
  void it(
    'commits successful multi-writer work and leaves the pool open',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(testConfig(resolveTestDatabaseUrl()));
      const homeA = randomUUID();
      const homeB = randomUUID();

      try {
        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await insertHome(tx, { id: homeA, name: 'Tx Home A' });
          await insertHome(tx, { id: homeB, name: 'Tx Home B' });
        });

        const found = await database.pool.query<{ id: string }>(
          'SELECT id FROM homes WHERE id = ANY($1) ORDER BY name',
          [[homeA, homeB]],
        );
        assert.equal(found.rows.length, 2);
        await database.pool.query('SELECT 1');
        assert.equal(database.pool.ended, false);
        assert.equal(database.pool.idleCount, database.pool.totalCount);
      } finally {
        await database.pool.query('DELETE FROM homes WHERE id = ANY($1)', [
          [homeA, homeB],
        ]);
        await database.close();
      }
    },
  );

  void it(
    'rolls back application failure so in-transaction writes are absent',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(testConfig(resolveTestDatabaseUrl()));
      const homeId = randomUUID();

      try {
        await assert.rejects(
          () =>
            runInReadCommittedTransaction(database.pool, async (tx) => {
              await insertHome(tx, { id: homeId, name: 'Rolled Back' });
              throw new Error('boom');
            }),
          (error: unknown) =>
            error instanceof Error && error.message === 'boom',
        );

        const found = await database.pool.query(
          'SELECT id FROM homes WHERE id = $1',
          [homeId],
        );
        assert.equal(found.rows.length, 0);
        assert.equal(database.pool.ended, false);
        assert.equal(database.pool.idleCount, database.pool.totalCount);
      } finally {
        await database.pool.query('DELETE FROM homes WHERE id = $1', [homeId]);
        await database.close();
      }
    },
  );

  void it(
    'rolls back when a persistence query fails',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(testConfig(resolveTestDatabaseUrl()));
      const homeId = randomUUID();

      try {
        await assert.rejects(() =>
          runInReadCommittedTransaction(database.pool, async (tx) => {
            await insertHome(tx, { id: homeId, name: 'Query Fail' });
            await tx.query('SELECT * FROM roomies_missing_relation_m21b');
          }),
        );

        const found = await database.pool.query(
          'SELECT id FROM homes WHERE id = $1',
          [homeId],
        );
        assert.equal(found.rows.length, 0);
        assert.equal(database.pool.idleCount, database.pool.totalCount);
      } finally {
        await database.pool.query('DELETE FROM homes WHERE id = $1', [homeId]);
        await database.close();
      }
    },
  );
});
