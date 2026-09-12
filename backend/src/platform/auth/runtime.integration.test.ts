import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveTestDatabaseUrl } from '../persistence/test-database.js';
import { createDatabasePool } from '../persistence/pool.js';
import { createDb } from '../../prisma/db.js';
import { createAuthRuntime } from './runtime.js';

const TEST_SECRET = 'roomies_test_secret_32_chars_minimum_value';

void describe('Prisma and Better Auth shared-pool integration', () => {
  void it(
    'uses one caller-owned pool across both runtimes',
    {
      skip:
        !process.env['TEST_DATABASE_URL'] && !process.env['DATABASE_URL']
          ? 'requires a migrated PostgreSQL test database'
          : false,
    },
    async () => {
      const databaseUrl = resolveTestDatabaseUrl();
      const config = {
        appEnv: 'test' as const,
        port: 3000,
        databaseUrl,
        authBaseUrl: 'http://localhost:3000',
        authSecret: TEST_SECRET,
        secureAuthCookies: false,
        frontendOrigin: 'http://localhost:5173',
        trustedOrigins: ['http://localhost:5173'],
        trustProxyHops: 0,
      };
      const database = createDatabasePool(config);
      const db = createDb(database.pool);
      const auth = createAuthRuntime(database.pool, config);
      const email = `m13b-${crypto.randomUUID()}@example.test`;
      let identityId: string | undefined;

      try {
        await db.connect();
        assert.equal(auth.options.database, database.pool);

        const signup = await auth.api.signUpEmail({
          body: {
            name: 'M1.3b Integration',
            email,
            password: 'test-password-only',
          },
        });
        identityId = signup.user.id;

        const result = await database.pool.query<{
          identity_exists: boolean;
          user_exists: boolean;
        }>(
          `SELECT
             EXISTS (SELECT 1 FROM auth_identities WHERE id = $1) AS identity_exists,
             EXISTS (SELECT 1 FROM users WHERE id = $1) AS user_exists`,
          [identityId],
        );
        assert.deepEqual(result.rows[0], {
          identity_exists: true,
          user_exists: true,
        });
      } finally {
        if (identityId) {
          await database.pool.query(
            'DELETE FROM auth_identities WHERE id = $1',
            [identityId],
          );
          await database.pool.query('DELETE FROM users WHERE id = $1', [
            identityId,
          ]);
        }
        await db.close();
        assert.equal(database.pool.ended, false);
        await database.close();
        assert.equal(database.pool.ended, true);
      }
    },
  );
});
