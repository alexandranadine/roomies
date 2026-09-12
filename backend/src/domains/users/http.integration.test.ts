import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRoomiesApiRouter } from '../../http/create-roomies-api.js';
import type { AppConfig } from '../../platform/config/types.js';
import { REQUEST_ID_HEADER } from '../../platform/http/constants.js';
import { createApp } from '../../platform/http/create-app.js';
import { withAppServer } from '../../platform/http/app-request.test-helper.js';
import {
  assertNoForbiddenLeak,
  COMMON_SECRET_SENTINELS,
} from '../../platform/http/assert-no-forbidden-leak.js';
import type { ApiErrorBody } from '../../platform/http/errors.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import { createDbReadiness } from '../../platform/persistence/readiness.js';
import { resolveTestDatabaseUrl } from '../../platform/persistence/test-database.js';
import { createDb } from '../../prisma/db.js';
import {
  createCanonicalUserLookup,
  createPrincipalResolver,
} from '../../platform/auth/principal.js';
import { createAuthRuntime } from '../../platform/auth/runtime.js';

const TEST_SECRET = 'roomies_test_secret_32_chars_minimum_value';
const TRUSTED_ORIGIN = 'http://localhost:5173';
const PASSWORD = 'test-password-only';
const SPOOFED_USER_ID = '22222222-2222-4222-8222-222222222222';

const skipWithoutDatabase =
  !process.env['TEST_DATABASE_URL'] && !process.env['DATABASE_URL']
    ? 'requires a migrated PostgreSQL test database'
    : false;

function authConfig(databaseUrl: string): AppConfig {
  return {
    appEnv: 'test',
    port: 3000,
    databaseUrl,
    authBaseUrl: 'http://localhost:3000',
    authSecret: TEST_SECRET,
    secureAuthCookies: false,
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

void describe('GET /api/v1/me HTTP integration', () => {
  void it(
    'authenticates against PostgreSQL and returns the canonical User id',
    { skip: skipWithoutDatabase },
    async () => {
      const databaseUrl = resolveTestDatabaseUrl();
      const config = authConfig(databaseUrl);
      const database = createDatabasePool(config);
      const db = createDb(database.pool);
      const auth = createAuthRuntime(database.pool, config);
      const principalResolver = createPrincipalResolver({
        auth,
        hasCanonicalUser: createCanonicalUserLookup(database.pool),
      });
      const email = `m14-${crypto.randomUUID()}@example.test`;
      const otherEmail = `m14-other-${crypto.randomUUID()}@example.test`;
      const identityIds: string[] = [];

      try {
        await db.connect();
        const app = createApp({
          config,
          readiness: createDbReadiness(db),
          auth,
          roomiesApi: createRoomiesApiRouter({
            principalResolver,
            activeHomeActorResolver: {
              resolve: () =>
                Promise.reject(
                  new Error('home actor resolver must not run for /me'),
                ),
            },
            homeReader: {
              findActiveHomeById: () =>
                Promise.reject(new Error('home reader must not run for /me')),
            },
            changeMembershipRole: () =>
              Promise.reject(new Error('role change must not run for /me')),
            leaveMembership: () =>
              Promise.reject(new Error('leave must not run for /me')),
          }),
        });

        await withAppServer(app, async (request) => {
          const health = await request({ path: '/health' });
          assert.equal(health.status, 200);
          assert.deepEqual(health.json(), { status: 'ok' });

          const ready = await request({ path: '/ready' });
          assert.notEqual(ready.status, 401);
          assert.ok(ready.status === 200 || ready.status === 503);

          const authOk = await request({ path: '/api/auth/ok' });
          assert.equal(authOk.status, 200);

          const unauthenticated = await request({ path: '/api/v1/me' });
          assert.equal(unauthenticated.status, 401);
          const unauthenticatedBody = unauthenticated.json() as ApiErrorBody;
          assert.equal(unauthenticatedBody.error.code, 'UNAUTHENTICATED');
          assert.equal(
            unauthenticatedBody.error.message,
            'Authentication required',
          );
          assert.equal(
            unauthenticatedBody.error.requestId,
            unauthenticated.headers.get(REQUEST_ID_HEADER),
          );
          assert.equal(
            unauthenticated.headers.get('cache-control'),
            'private, no-store',
          );

          const malformed = await request({
            path: '/api/v1/me',
            headers: { Cookie: 'better-auth.session_token=%%%not-a-session' },
          });
          assert.equal(malformed.status, 401);
          const malformedBody = malformed.json() as ApiErrorBody;
          assert.equal(malformedBody.error.code, 'UNAUTHENTICATED');

          const signup = await request({
            method: 'POST',
            path: '/api/auth/sign-up/email',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              name: 'M1.4 Current User',
              email,
              password: PASSWORD,
            }),
          });
          assert.ok(signup.status >= 200 && signup.status < 300);
          const signupBody = signup.json() as {
            user?: { id?: string; email?: string };
          };
          const identityId = signupBody.user?.id;
          assert.ok(identityId);
          identityIds.push(identityId);

          const userRow = await database.pool.query<{ id: string }>(
            'SELECT id FROM users WHERE id = $1',
            [identityId],
          );
          assert.equal(userRow.rows[0]?.id, identityId);

          const sessionCookie = findSessionSetCookie(signup.headers);
          assert.ok(sessionCookie);

          const me = await request({
            path: `/api/v1/me?userId=${SPOOFED_USER_ID}`,
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: sessionCookieHeader(sessionCookie),
              'x-user-id': SPOOFED_USER_ID,
            },
          });
          assert.equal(me.status, 200);
          assert.deepEqual(me.json(), { id: identityId });
          assert.equal(me.headers.get('cache-control'), 'private, no-store');
          assert.equal(
            me.headers.get('access-control-allow-origin'),
            TRUSTED_ORIGIN,
          );
          assert.ok(me.headers.get('x-content-type-options'));
          assert.match(
            me.headers.get(REQUEST_ID_HEADER) ?? '',
            /^[0-9a-f-]{36}$/i,
          );
          assertNoForbiddenLeak({
            context: 'authenticated /me integration body',
            text: me.text,
            forbidden: [
              ...COMMON_SECRET_SENTINELS,
              PASSWORD,
              TEST_SECRET,
              email,
              'session',
              'token',
              'account',
              'membership',
              'homeId',
              SPOOFED_USER_ID,
            ],
          });

          const otherSignup = await request({
            method: 'POST',
            path: '/api/auth/sign-up/email',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              name: 'M1.4 Other User',
              email: otherEmail,
              password: PASSWORD,
            }),
          });
          assert.ok(otherSignup.status >= 200 && otherSignup.status < 300);
          const otherId = (otherSignup.json() as { user?: { id?: string } })
            .user?.id;
          assert.ok(otherId);
          identityIds.push(otherId);

          const stillFirstUser = await request({
            path: `/api/v1/me?userId=${otherId}`,
            headers: {
              Cookie: sessionCookieHeader(sessionCookie),
              'x-user-id': otherId,
            },
          });
          assert.equal(stillFirstUser.status, 200);
          assert.deepEqual(stillFirstUser.json(), { id: identityId });

          const authStillMounted = await request({ path: '/api/auth/ok' });
          assert.equal(authStillMounted.status, 200);
        });
      } finally {
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
