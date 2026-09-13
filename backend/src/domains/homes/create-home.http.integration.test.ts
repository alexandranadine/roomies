import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { createCreateHomeFromPool } from '../../application/homes/create-home.js';
import { createRoomiesApiRouter } from '../../http/create-roomies-api.js';
import {
  createCanonicalUserLookup,
  createPrincipalResolver,
} from '../../platform/auth/principal.js';
import { createAuthRuntime } from '../../platform/auth/runtime.js';
import type { AppConfig } from '../../platform/config/types.js';
import { withAppServer } from '../../platform/http/app-request.test-helper.js';
import {
  assertNoForbiddenLeak,
  COMMON_SECRET_SENTINELS,
} from '../../platform/http/assert-no-forbidden-leak.js';
import { createApp } from '../../platform/http/create-app.js';
import type { ApiErrorBody } from '../../platform/http/errors.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import { createDbReadiness } from '../../platform/persistence/readiness.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { createDb } from '../../prisma/db.js';
import { createdHomeDtoSchema } from './created-home-dto.js';
import { createHomeRepository } from './repository/home-repository.js';
import { createActiveHomeActorResolver } from '../memberships/active-home-actor-resolver.js';

const TEST_SECRET = 'roomies_test_secret_32_chars_minimum_value';
const TRUSTED_ORIGIN = 'http://localhost:5173';
const HOSTILE_ORIGIN = 'https://evil.example';
const PASSWORD = 'test-password-only';
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();

function authConfig(databaseUrl: string): AppConfig {
  return {
    appEnv: 'test',
    port: 3000,
    databaseUrl,
    authBaseUrl: 'http://localhost:3000',
    authSecret: TEST_SECRET,
    secureAuthCookies: false,
    frontendOrigin: TRUSTED_ORIGIN,
    trustedOrigins: [TRUSTED_ORIGIN],
    trustProxyHops: 0,
  };
}

function findSessionSetCookie(headers: Headers): string | undefined {
  return headers
    .getSetCookie()
    .find((cookie) => /session_token=/i.test(cookie.split(';')[0] ?? ''));
}

function sessionCookieHeader(setCookie: string): string {
  return setCookie.split(';', 1)[0] ?? '';
}

void describe('POST /api/v1/homes PostgreSQL', () => {
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
    'creates Homes for a signed-in canonical User and rejects untrusted mutations',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const databaseUrl = resolveSafeDedicatedTestDatabaseUrl();
      const config = authConfig(databaseUrl);
      const database = createDatabasePool(config);
      const db = createDb(database.pool);
      const auth = createAuthRuntime(database.pool, config);
      const identityIds: string[] = [];
      const homeIds: string[] = [];

      try {
        await db.connect();
        const app = createApp({
          config,
          readiness: createDbReadiness(db),
          auth,
          roomiesApi: createRoomiesApiRouter({
            principalResolver: createPrincipalResolver({
              auth,
              hasCanonicalUser: createCanonicalUserLookup(database.pool),
            }),
            activeHomeActorResolver: createActiveHomeActorResolver(
              database.pool,
            ),
            homeReader: createHomeRepository(database.pool),
            createHome: createCreateHomeFromPool(database.pool),
            archiveFinalMemberHome: () =>
              Promise.reject(new Error('archive must not run for home create')),
            changeMembershipRole: () =>
              Promise.reject(new Error('role change must not run')),
            leaveMembership: () =>
              Promise.reject(new Error('leave must not run')),
            removeMembership: () =>
              Promise.reject(new Error('remove must not run')),
          }),
        });

        await withAppServer(app, async (request) => {
          const unauthenticated = await request({
            method: 'POST',
            path: '/api/v1/homes',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ name: 'Oak Street', timezone: 'UTC' }),
          });
          assert.equal(unauthenticated.status, 401);
          assert.equal(
            (unauthenticated.json() as ApiErrorBody).error.code,
            'UNAUTHENTICATED',
          );

          const email = `m23a-create-${randomUUID()}@example.test`;
          const signup = await request({
            method: 'POST',
            path: '/api/auth/sign-up/email',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              name: 'Creator',
              email,
              password: PASSWORD,
            }),
          });
          assert.ok(signup.status >= 200 && signup.status < 300);
          const userId = (signup.json() as { user?: { id?: string } }).user?.id;
          assert.ok(userId);
          identityIds.push(userId);
          const cookie = findSessionSetCookie(signup.headers);
          assert.ok(cookie);
          const session = sessionCookieHeader(cookie);

          const missingOrigin = await request({
            method: 'POST',
            path: '/api/v1/homes',
            headers: {
              Cookie: session,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ name: 'Oak Street', timezone: 'UTC' }),
          });
          assert.equal(missingOrigin.status, 403);
          assert.equal(
            (missingOrigin.json() as ApiErrorBody).error.code,
            'FORBIDDEN',
          );

          const hostile = await request({
            method: 'POST',
            path: '/api/v1/homes',
            headers: {
              Origin: HOSTILE_ORIGIN,
              Cookie: session,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ name: 'Oak Street', timezone: 'UTC' }),
          });
          assert.equal(hostile.status, 403);
          assert.equal(
            (hostile.json() as ApiErrorBody).error.code,
            'FORBIDDEN',
          );
          assert.equal(hostile.text.includes(HOSTILE_ORIGIN), false);

          const created = await request({
            method: 'POST',
            path: '/api/v1/homes',
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: session,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              name: '  Oak Street  ',
              timezone: 'America/Los_Angeles',
            }),
          });
          assert.equal(created.status, 201);
          assert.equal(
            created.headers.get('cache-control'),
            'private, no-store',
          );
          const body = createdHomeDtoSchema.parse(created.json());
          homeIds.push(body.home.id);
          assert.match(body.home.id, UUID_V7);
          assert.match(body.membership.id, UUID_V7);
          assert.equal(body.home.name, 'Oak Street');
          assert.equal(body.home.timezone, 'America/Los_Angeles');
          assert.equal(body.membership.role, 'ADMIN');
          assertNoForbiddenLeak({
            context: 'HTTP create home 201',
            text: created.text,
            forbidden: [
              ...COMMON_SECRET_SENTINELS,
              'owner',
              'founder',
              'primaryAdmin',
              email,
              PASSWORD,
              'SELECT',
              'joined_at',
            ],
          });

          const persisted = await database.pool.query<{
            role: string;
            ended_at: Date | null;
            user_id: string;
          }>(
            `SELECT role, ended_at, user_id FROM memberships WHERE home_id = $1`,
            [body.home.id],
          );
          assert.equal(persisted.rowCount, 1);
          assert.equal(persisted.rows[0]?.role, 'ADMIN');
          assert.equal(persisted.rows[0]?.ended_at, null);
          assert.equal(persisted.rows[0]?.user_id, userId);

          const second = await request({
            method: 'POST',
            path: '/api/v1/homes',
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: session,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ name: 'Pine Avenue', timezone: 'UTC' }),
          });
          assert.equal(second.status, 201);
          const secondBody = createdHomeDtoSchema.parse(second.json());
          homeIds.push(secondBody.home.id);
          assert.notEqual(secondBody.home.id, body.home.id);

          const [concurrentA, concurrentB] = await Promise.all([
            request({
              method: 'POST',
              path: '/api/v1/homes',
              headers: {
                Origin: TRUSTED_ORIGIN,
                Cookie: session,
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                name: 'Concurrent A',
                timezone: 'UTC',
              }),
            }),
            request({
              method: 'POST',
              path: '/api/v1/homes',
              headers: {
                Origin: TRUSTED_ORIGIN,
                Cookie: session,
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                name: 'Concurrent B',
                timezone: 'UTC',
              }),
            }),
          ]);
          assert.equal(concurrentA.status, 201);
          assert.equal(concurrentB.status, 201);
          const concurrentBodyA = createdHomeDtoSchema.parse(
            concurrentA.json(),
          );
          const concurrentBodyB = createdHomeDtoSchema.parse(
            concurrentB.json(),
          );
          homeIds.push(concurrentBodyA.home.id, concurrentBodyB.home.id);
          assert.notEqual(concurrentBodyA.home.id, concurrentBodyB.home.id);
          assert.notEqual(
            concurrentBodyA.membership.id,
            concurrentBodyB.membership.id,
          );
        });
      } finally {
        if (homeIds.length > 0) {
          await database.pool.query(
            'DELETE FROM outbox_events WHERE home_id = ANY($1)',
            [homeIds],
          );
          await database.pool.query(
            'DELETE FROM memberships WHERE home_id = ANY($1)',
            [homeIds],
          );
          await database.pool.query('DELETE FROM homes WHERE id = ANY($1)', [
            homeIds,
          ]);
        }
        for (const id of identityIds) {
          await database.pool.query(
            'DELETE FROM auth_identities WHERE id = $1',
            [id],
          );
          await database.pool.query('DELETE FROM users WHERE id = $1', [id]);
        }
        await db.close();
        await database.close();
      }
    },
  );
});
