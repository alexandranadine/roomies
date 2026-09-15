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
import { appendExpiredAuthSessionCookieAfterCommit } from './expired-session-cookie.js';
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
  value: string;
  attributes: string[];
} {
  const parts = setCookie.split(';').map((part) => part.trim());
  const pair = parts[0] ?? '';
  const separator = pair.indexOf('=');
  return {
    name: separator >= 0 ? pair.slice(0, separator) : pair,
    value: separator >= 0 ? pair.slice(separator + 1) : '',
    attributes: parts.slice(1).map((part) => part.toLowerCase()),
  };
}

function attribute(parts: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  return parts.find((part) => part === name || part.startsWith(prefix));
}

void describe('post-commit session cookie expiry HTTP', () => {
  void it(
    'expires the live Better Auth session cookie only after commit',
    { skip: skipWithoutDatabase },
    async () => {
      const databaseUrl = resolveTestDatabaseUrl();
      const config = authConfig(databaseUrl);
      const database = createDatabasePool(config);
      const db = createDb(database.pool);
      const auth = createAuthRuntime(database.pool, config);
      const email = `m85-cookie-${crypto.randomUUID()}@example.test`;
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
            expressApp.post(
              '/__test/session-cookie-after-mutation',
              (req, res) => {
                const body: unknown = req.body;
                const committed =
                  typeof body === 'object' &&
                  body !== null &&
                  'committed' in body &&
                  body.committed === true;
                appendExpiredAuthSessionCookieAfterCommit(
                  res,
                  committed ? 'committed' : 'aborted',
                  auth,
                );
                res.status(committed ? 200 : 409).json({ ok: committed });
              },
            );
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
              name: 'M8.5 Cookie Expiry',
              email,
              password: PASSWORD,
            }),
          });
          assert.ok(signup.status >= 200 && signup.status < 300);
          const signupBody = signup.json() as { user?: { id?: string } };
          identityId = signupBody.user?.id;
          assert.ok(identityId);

          const issued = findSessionSetCookie(signup.headers);
          assert.ok(issued);
          const issuedAttrs = cookieNameAndAttributes(issued);
          assert.ok(issuedAttrs.value.length > 0);

          const failed = await request({
            method: 'POST',
            path: '/__test/session-cookie-after-mutation',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ committed: false }),
          });
          assert.equal(failed.status, 409);
          assert.equal(findSessionSetCookie(failed.headers), undefined);
          assert.equal(failed.headers.getSetCookie().length, 0);

          const succeeded = await request({
            method: 'POST',
            path: '/__test/session-cookie-after-mutation',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ committed: true }),
          });
          assert.equal(succeeded.status, 200);
          const expired = findSessionSetCookie(succeeded.headers);
          assert.ok(expired);
          const expiredAttrs = cookieNameAndAttributes(expired);

          assert.equal(expiredAttrs.name, issuedAttrs.name);
          assert.equal(expiredAttrs.value, '');
          assert.ok(expiredAttrs.attributes.includes('max-age=0'));
          assert.equal(
            expiredAttrs.attributes.includes('httponly'),
            issuedAttrs.attributes.includes('httponly'),
          );
          assert.equal(
            attribute(expiredAttrs.attributes, 'path'),
            attribute(issuedAttrs.attributes, 'path'),
          );
          assert.equal(
            attribute(expiredAttrs.attributes, 'samesite'),
            attribute(issuedAttrs.attributes, 'samesite'),
          );
          assert.equal(
            attribute(expiredAttrs.attributes, 'domain'),
            attribute(issuedAttrs.attributes, 'domain'),
          );
          assert.equal(
            expiredAttrs.attributes.includes('secure'),
            issuedAttrs.attributes.includes('secure'),
          );
          assert.equal(expired.includes(issuedAttrs.value), false);
          assert.match(
            succeeded.headers.get(REQUEST_ID_HEADER) ?? '',
            /^[0-9a-f-]{36}$/i,
          );

          assertNoForbiddenLeak({
            context: 'cookie expiry success body',
            text: succeeded.text,
            forbidden: [
              ...COMMON_SECRET_SENTINELS,
              PASSWORD,
              TEST_SECRET,
              issuedAttrs.value,
              'better-auth.session_token=',
            ],
          });
          assertNoForbiddenLeak({
            context: 'cookie expiry failure body',
            text: failed.text,
            forbidden: [
              ...COMMON_SECRET_SENTINELS,
              PASSWORD,
              TEST_SECRET,
              issuedAttrs.value,
            ],
          });
        });

        assertNoForbiddenLeak({
          context: 'cookie expiry logs',
          text: logs.join('\n'),
          forbidden: [
            PASSWORD,
            TEST_SECRET,
            email,
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
    'preserves Secure on expiry when the runtime issues Secure session cookies',
    { skip: skipWithoutDatabase },
    async () => {
      const databaseUrl = resolveTestDatabaseUrl();
      const config = authConfig(databaseUrl, { secureAuthCookies: true });
      const database = createDatabasePool(config);
      const db = createDb(database.pool);
      const auth = createAuthRuntime(database.pool, config);
      const email = `m85-cookie-secure-${crypto.randomUUID()}@example.test`;
      let identityId: string | undefined;

      try {
        await db.connect();
        const app = createApp({
          config,
          readiness: createDbReadiness(db),
          auth,
          configure(expressApp) {
            expressApp.post(
              '/__test/session-cookie-after-mutation',
              (_req, res) => {
                appendExpiredAuthSessionCookieAfterCommit(
                  res,
                  'committed',
                  auth,
                );
                res.status(200).json({ ok: true });
              },
            );
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
              name: 'M8.5 Secure Cookie Expiry',
              email,
              password: PASSWORD,
            }),
          });
          assert.ok(signup.status >= 200 && signup.status < 300);
          const body = signup.json() as { user?: { id?: string } };
          identityId = body.user?.id;
          const issued = findSessionSetCookie(signup.headers);
          assert.ok(issued);
          const issuedAttrs = cookieNameAndAttributes(issued);
          assert.ok(issuedAttrs.attributes.includes('secure'));

          const succeeded = await request({
            method: 'POST',
            path: '/__test/session-cookie-after-mutation',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          });
          const expired = findSessionSetCookie(succeeded.headers);
          assert.ok(expired);
          const expiredAttrs = cookieNameAndAttributes(expired);
          assert.equal(expiredAttrs.name, issuedAttrs.name);
          assert.ok(expiredAttrs.attributes.includes('secure'));
          assert.ok(expiredAttrs.attributes.includes('httponly'));
          assert.ok(expiredAttrs.attributes.includes('path=/'));
          assert.ok(
            expiredAttrs.attributes.some((attr) =>
              attr.startsWith('samesite=lax'),
            ),
          );
          assert.ok(expiredAttrs.attributes.includes('max-age=0'));
          assert.equal(expired.includes(issuedAttrs.value), false);
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
