import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AppConfig } from '../config/types.js';
import { REQUEST_ID_HEADER } from '../http/constants.js';
import { createApp } from '../http/create-app.js';
import { withAppServer } from '../http/app-request.test-helper.js';
import {
  assertNoForbiddenLeak,
  COMMON_SECRET_SENTINELS,
} from '../http/assert-no-forbidden-leak.js';
import { createDatabasePool } from '../persistence/pool.js';
import { createDbReadiness } from '../persistence/readiness.js';
import { resolveTestDatabaseUrl } from '../persistence/test-database.js';
import { createDb } from '../../prisma/db.js';
import {
  createCanonicalUserLookup,
  createPrincipalResolver,
} from './principal.js';
import { createAuthRuntime } from './runtime.js';

const TEST_SECRET = 'roomies_test_secret_32_chars_minimum_value';
const TRUSTED_ORIGIN = 'http://localhost:5173';
const PASSWORD = 'test-password-only';

const skipWithoutDatabase =
  !process.env['TEST_DATABASE_URL'] && !process.env['DATABASE_URL']
    ? 'requires a migrated PostgreSQL test database'
    : false;

function authConfig(
  databaseUrl: string,
  overrides: Partial<AppConfig> = {},
): AppConfig {
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
    ...overrides,
  };
}

function findSessionSetCookie(headers: Headers): string | undefined {
  return headers
    .getSetCookie()
    .find((cookie) => /session_token=/i.test(cookie.split(';')[0] ?? ''));
}

function cookieNameAndAttributes(setCookie: string): {
  name: string;
  attributes: string[];
} {
  const parts = setCookie.split(';').map((part) => part.trim());
  const name = parts[0]?.split('=')[0] ?? '';
  return {
    name,
    attributes: parts.slice(1).map((part) => part.toLowerCase()),
  };
}

function sessionCookieHeader(setCookie: string): string {
  return setCookie.split(';', 1)[0] ?? '';
}

function sessionTokenValue(setCookie: string): string {
  const pair = setCookie.split(';', 1)[0] ?? '';
  return pair.slice(pair.indexOf('=') + 1);
}

void describe('Better Auth HTTP integration', () => {
  void it(
    'mounts auth, provisions a User, and resolves a session principal',
    { skip: skipWithoutDatabase },
    async () => {
      const databaseUrl = resolveTestDatabaseUrl();
      const config = authConfig(databaseUrl);
      const database = createDatabasePool(config);
      const db = createDb(database.pool);
      const auth = createAuthRuntime(database.pool, config);
      const resolver = createPrincipalResolver({
        auth,
        hasCanonicalUser: createCanonicalUserLookup(database.pool),
      });
      const email = `m13c-${crypto.randomUUID()}@example.test`;
      const signupEmail = `  ${email.toUpperCase()}  `;
      const logs: string[] = [];
      const originalError = console.error;
      const originalWarn = console.warn;
      console.error = (...args: unknown[]) => {
        logs.push(args.map((value) => JSON.stringify(value)).join(' '));
      };
      console.warn = (...args: unknown[]) => {
        logs.push(args.map((value) => JSON.stringify(value)).join(' '));
      };

      let identityId: string | undefined;

      try {
        await db.connect();
        const app = createApp({
          config,
          readiness: createDbReadiness(db),
          auth,
          configure(expressApp) {
            expressApp.get('/__test/principal', (req, res, next) => {
              void resolver
                .resolvePrincipal(req)
                .then((principal) => {
                  res.status(200).json({ principal });
                })
                .catch(next);
            });
          },
        });

        await withAppServer(app, async (request) => {
          const mounted = await request({ path: '/api/auth/ok' });
          assert.equal(mounted.status, 200);
          assert.match(
            mounted.headers.get(REQUEST_ID_HEADER) ?? '',
            /^[0-9a-f-]{36}$/i,
          );
          assert.notEqual(
            mounted.headers.get(REQUEST_ID_HEADER),
            'client-controlled-id',
          );
          assert.ok(mounted.headers.get('x-content-type-options'));
          assert.ok(
            mounted.headers.get('x-frame-options') ||
              mounted.headers.get('content-security-policy'),
          );

          const ignoredClientId = await request({
            path: '/api/auth/ok',
            headers: { [REQUEST_ID_HEADER]: 'client-controlled-id' },
          });
          assert.notEqual(
            ignoredClientId.headers.get(REQUEST_ID_HEADER),
            'client-controlled-id',
          );

          const allowedCors = await request({
            method: 'OPTIONS',
            path: '/api/auth/sign-in/email',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'Access-Control-Request-Method': 'POST',
            },
          });
          assert.equal(
            allowedCors.headers.get('access-control-allow-origin'),
            TRUSTED_ORIGIN,
          );
          assert.equal(
            allowedCors.headers.get('access-control-allow-credentials'),
            'true',
          );

          const deniedCors = await request({
            method: 'OPTIONS',
            path: '/api/auth/sign-in/email',
            headers: {
              Origin: 'https://evil.example',
              'Access-Control-Request-Method': 'POST',
            },
          });
          assert.equal(
            deniedCors.headers.get('access-control-allow-origin'),
            null,
          );

          const noOrigin = await request({ path: '/api/auth/ok' });
          assert.equal(noOrigin.status, 200);
          assert.equal(
            noOrigin.headers.get('access-control-allow-origin'),
            null,
          );

          const unauthenticated = await request({ path: '/__test/principal' });
          assert.equal(unauthenticated.status, 200);
          assert.deepEqual(unauthenticated.json(), { principal: null });

          const malformed = await request({
            path: '/__test/principal',
            headers: { Cookie: 'better-auth.session_token=%%%not-a-session' },
          });
          assert.equal(malformed.status, 200);
          assert.deepEqual(malformed.json(), { principal: null });

          const signup = await request({
            method: 'POST',
            path: '/api/auth/sign-up/email',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              name: 'M1.3c Integration',
              email: signupEmail,
              password: PASSWORD,
            }),
          });
          assert.ok(signup.status >= 200 && signup.status < 300);

          const signupBody = signup.json() as {
            user?: { id?: string; email?: string };
          };
          identityId = signupBody.user?.id;
          assert.ok(identityId);
          assert.equal(signupBody.user?.email, email);

          const signupCookie = findSessionSetCookie(signup.headers);
          assert.ok(signupCookie);
          const insecureAttrs = cookieNameAndAttributes(signupCookie);
          assert.match(insecureAttrs.name, /session_token/i);
          assert.ok(insecureAttrs.attributes.includes('httponly'));
          assert.ok(
            insecureAttrs.attributes.some((attr) =>
              attr.startsWith('samesite=lax'),
            ),
          );
          assert.equal(
            insecureAttrs.attributes.some((attr) => attr === 'secure'),
            false,
          );

          const signupToken = sessionTokenValue(signupCookie);
          assertNoForbiddenLeak({
            context: 'signup JSON body',
            text: signup.text,
            forbidden: [
              ...COMMON_SECRET_SENTINELS,
              PASSWORD,
              signupToken,
              TEST_SECRET,
              'postgresql://',
            ],
          });

          const rows = await database.pool.query<{
            identity_count: string;
            user_count: string;
            account_count: string;
            session_count: string;
            stored_email: string;
            email_verified: boolean;
          }>(
            `SELECT
               (SELECT count(*)::text FROM auth_identities WHERE id = $1) AS identity_count,
               (SELECT count(*)::text FROM users WHERE id = $1) AS user_count,
               (SELECT count(*)::text FROM auth_accounts WHERE user_id = $1) AS account_count,
               (SELECT count(*)::text FROM auth_sessions WHERE user_id = $1) AS session_count,
               (SELECT email FROM auth_identities WHERE id = $1) AS stored_email,
               (SELECT email_verified FROM auth_identities WHERE id = $1) AS email_verified`,
            [identityId],
          );
          assert.deepEqual(rows.rows[0], {
            identity_count: '1',
            user_count: '1',
            account_count: '1',
            session_count: '1',
            stored_email: email,
            email_verified: false,
          });

          const duplicateSignup = await request({
            method: 'POST',
            path: '/api/auth/sign-up/email',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              name: 'M1.3c Duplicate',
              email: ` ${email.toUpperCase()} `,
              password: PASSWORD,
            }),
          });
          assert.ok(
            duplicateSignup.status >= 400 && duplicateSignup.status < 500,
          );
          const afterDuplicate = await database.pool.query<{
            user_count: string;
          }>('SELECT count(*)::text AS user_count FROM users WHERE id = $1', [
            identityId,
          ]);
          assert.equal(afterDuplicate.rows[0]?.user_count, '1');

          const afterSignup = await request({
            path: '/__test/principal',
            headers: { Cookie: sessionCookieHeader(signupCookie) },
          });
          assert.deepEqual(afterSignup.json(), {
            principal: { userId: identityId },
          });

          const session = await request({
            path: '/api/auth/get-session',
            headers: { Cookie: sessionCookieHeader(signupCookie) },
          });
          assert.equal(session.status, 200);
          const sessionBody = session.json() as {
            user?: { email?: string; emailVerified?: boolean };
          };
          assert.equal(sessionBody.user?.email, email);
          assert.equal(sessionBody.user?.emailVerified, false);

          const signOut = await request({
            method: 'POST',
            path: '/api/auth/sign-out',
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: sessionCookieHeader(signupCookie),
            },
          });
          assert.ok(signOut.status >= 200 && signOut.status < 300);

          const afterLogout = await request({
            path: '/__test/principal',
            headers: { Cookie: sessionCookieHeader(signupCookie) },
          });
          assert.deepEqual(afterLogout.json(), { principal: null });
          const sessionsAfterLogout = await database.pool.query<{
            session_count: string;
          }>(
            'SELECT count(*)::text AS session_count FROM auth_sessions WHERE user_id = $1',
            [identityId],
          );
          assert.equal(sessionsAfterLogout.rows[0]?.session_count, '0');

          const invalidLogin = await request({
            method: 'POST',
            path: '/api/auth/sign-in/email',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              email,
              password: 'wrong-password-value',
            }),
          });
          assert.ok(invalidLogin.status >= 400 && invalidLogin.status < 500);
          assert.notEqual(invalidLogin.status, 500);
          assert.equal(findSessionSetCookie(invalidLogin.headers), undefined);
          assertNoForbiddenLeak({
            context: 'invalid login body',
            text: invalidLogin.text,
            forbidden: [
              ...COMMON_SECRET_SENTINELS,
              PASSWORD,
              'wrong-password-value',
              TEST_SECRET,
              'auth_accounts',
              'stack',
            ],
          });
          const sessionsAfterInvalid = await database.pool.query<{
            session_count: string;
          }>(
            'SELECT count(*)::text AS session_count FROM auth_sessions WHERE user_id = $1',
            [identityId],
          );
          assert.equal(sessionsAfterInvalid.rows[0]?.session_count, '0');

          const login = await request({
            method: 'POST',
            path: '/api/auth/sign-in/email',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              email,
              password: PASSWORD,
            }),
          });
          assert.ok(login.status >= 200 && login.status < 300);
          const loginCookie = findSessionSetCookie(login.headers);
          assert.ok(loginCookie);
          const afterLogin = await request({
            path: '/__test/principal',
            headers: { Cookie: sessionCookieHeader(loginCookie) },
          });
          assert.deepEqual(afterLogin.json(), {
            principal: { userId: identityId },
          });

          await database.pool.query(
            "UPDATE auth_sessions SET expires_at = NOW() - INTERVAL '1 day' WHERE user_id = $1",
            [identityId],
          );
          const expired = await request({
            path: '/__test/principal',
            headers: { Cookie: sessionCookieHeader(loginCookie) },
          });
          assert.deepEqual(expired.json(), { principal: null });
        });

        assertNoForbiddenLeak({
          context: 'auth HTTP logs',
          text: logs.join('\n'),
          forbidden: [
            PASSWORD,
            TEST_SECRET,
            'wrong-password-value',
            'better-auth.session_token=',
            'Cookie',
            'Authorization',
            'postgresql://',
          ],
        });
      } finally {
        console.error = originalError;
        console.warn = originalWarn;
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
        await database.close();
      }
    },
  );

  void it(
    'rejects state-changing sign-in from a hostile Origin',
    { skip: skipWithoutDatabase },
    async () => {
      const databaseUrl = resolveTestDatabaseUrl();
      const config = authConfig(databaseUrl);
      const database = createDatabasePool(config);
      const db = createDb(database.pool);
      const auth = createAuthRuntime(database.pool, config);
      const resolver = createPrincipalResolver({
        auth,
        hasCanonicalUser: createCanonicalUserLookup(database.pool),
      });
      const email = `m13c-hostile-${crypto.randomUUID()}@example.test`;
      const hostileOrigin = 'https://evil.example';
      let identityId: string | undefined;

      try {
        await db.connect();
        const app = createApp({
          config,
          readiness: createDbReadiness(db),
          auth,
          configure(expressApp) {
            expressApp.get('/__test/principal', (req, res, next) => {
              void resolver
                .resolvePrincipal(req)
                .then((principal) => {
                  res.status(200).json({ principal });
                })
                .catch(next);
            });
          },
        });

        await withAppServer(app, async (request) => {
          const signup = await request({
            method: 'POST',
            path: '/api/auth/sign-up/email',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              name: 'M1.3c Hostile Origin',
              email,
              password: PASSWORD,
            }),
          });
          assert.ok(signup.status >= 200 && signup.status < 300);
          const signupBody = signup.json() as { user?: { id?: string } };
          identityId = signupBody.user?.id;
          assert.ok(identityId);
          const signupCookie = findSessionSetCookie(signup.headers);
          assert.ok(signupCookie);

          const signOut = await request({
            method: 'POST',
            path: '/api/auth/sign-out',
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: sessionCookieHeader(signupCookie),
            },
          });
          assert.ok(signOut.status >= 200 && signOut.status < 300);

          const beforeHostile = await database.pool.query<{
            user_count: string;
            session_count: string;
          }>(
            `SELECT
               (SELECT count(*)::text FROM users WHERE id = $1) AS user_count,
               (SELECT count(*)::text FROM auth_sessions WHERE user_id = $1) AS session_count`,
            [identityId],
          );
          assert.deepEqual(beforeHostile.rows[0], {
            user_count: '1',
            session_count: '0',
          });

          const hostileSignIn = await request({
            method: 'POST',
            path: '/api/auth/sign-in/email',
            headers: {
              Origin: hostileOrigin,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              email,
              password: PASSWORD,
            }),
          });
          assert.equal(hostileSignIn.status, 403);
          assert.match(hostileSignIn.text, /INVALID_ORIGIN/);
          assert.equal(findSessionSetCookie(hostileSignIn.headers), undefined);
          assert.equal(
            hostileSignIn.headers.get('access-control-allow-origin'),
            null,
          );
          assertNoForbiddenLeak({
            context: 'hostile-origin sign-in body',
            text: hostileSignIn.text,
            forbidden: [
              ...COMMON_SECRET_SENTINELS,
              PASSWORD,
              TEST_SECRET,
              'AUTH_SECRET',
              'postgresql://',
              'auth_sessions',
              'stack',
            ],
          });

          const afterHostile = await database.pool.query<{
            user_count: string;
            session_count: string;
          }>(
            `SELECT
               (SELECT count(*)::text FROM users WHERE id = $1) AS user_count,
               (SELECT count(*)::text FROM auth_sessions WHERE user_id = $1) AS session_count`,
            [identityId],
          );
          assert.deepEqual(afterHostile.rows[0], {
            user_count: '1',
            session_count: '0',
          });

          const unauthenticated = await request({ path: '/__test/principal' });
          assert.deepEqual(unauthenticated.json(), { principal: null });

          const trustedLogin = await request({
            method: 'POST',
            path: '/api/auth/sign-in/email',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              email,
              password: PASSWORD,
            }),
          });
          assert.ok(trustedLogin.status >= 200 && trustedLogin.status < 300);
          const loginCookie = findSessionSetCookie(trustedLogin.headers);
          assert.ok(loginCookie);

          const sessionsAfterTrustedLogin = await database.pool.query<{
            session_count: string;
          }>(
            'SELECT count(*)::text AS session_count FROM auth_sessions WHERE user_id = $1',
            [identityId],
          );
          assert.equal(sessionsAfterTrustedLogin.rows[0]?.session_count, '1');

          const hostileSignOut = await request({
            method: 'POST',
            path: '/api/auth/sign-out',
            headers: {
              Origin: hostileOrigin,
              Cookie: sessionCookieHeader(loginCookie),
            },
          });
          assert.equal(hostileSignOut.status, 403);
          assert.match(hostileSignOut.text, /INVALID_ORIGIN/);
          assert.equal(
            hostileSignOut.headers.get('access-control-allow-origin'),
            null,
          );

          const afterHostileSignOut = await database.pool.query<{
            session_count: string;
          }>(
            'SELECT count(*)::text AS session_count FROM auth_sessions WHERE user_id = $1',
            [identityId],
          );
          assert.equal(afterHostileSignOut.rows[0]?.session_count, '1');

          const stillAuthenticated = await request({
            path: '/__test/principal',
            headers: { Cookie: sessionCookieHeader(loginCookie) },
          });
          assert.deepEqual(stillAuthenticated.json(), {
            principal: { userId: identityId },
          });
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
        await database.close();
      }
    },
  );

  void it(
    'sets Secure session cookies when configured',
    { skip: skipWithoutDatabase },
    async () => {
      const databaseUrl = resolveTestDatabaseUrl();
      const config = authConfig(databaseUrl, { secureAuthCookies: true });
      const database = createDatabasePool(config);
      const db = createDb(database.pool);
      const auth = createAuthRuntime(database.pool, config);
      const email = `m13c-secure-${crypto.randomUUID()}@example.test`;
      let identityId: string | undefined;

      try {
        await db.connect();
        const app = createApp({
          config,
          readiness: createDbReadiness(db),
          auth,
        });

        await withAppServer(app, async (request) => {
          const signup = await request({
            method: 'POST',
            path: '/api/auth/sign-up/email',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              name: 'M1.3c Secure Cookie',
              email,
              password: PASSWORD,
            }),
          });
          assert.ok(signup.status >= 200 && signup.status < 300);
          const body = signup.json() as { user?: { id?: string } };
          identityId = body.user?.id;
          const setCookie = findSessionSetCookie(signup.headers);
          assert.ok(setCookie);
          const attrs = cookieNameAndAttributes(setCookie);
          assert.ok(attrs.attributes.includes('httponly'));
          assert.ok(
            attrs.attributes.some((attr) => attr.startsWith('samesite=lax')),
          );
          assert.ok(attrs.attributes.includes('secure'));
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
        await database.close();
      }
    },
  );
});
