import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { AppConfig } from '../config/types.js';
import { createFakeTransactionalEmailSender } from '../email/fake-sender.js';
import type { TransactionalEmailSender } from '../email/types.js';
import { PASSWORD_RESET_EMAIL_SUBJECT } from '../email/password-reset-message.js';
import { withAppServer } from '../http/app-request.test-helper.js';
import {
  assertNoForbiddenLeak,
  COMMON_SECRET_SENTINELS,
} from '../http/assert-no-forbidden-leak.js';
import { createApp } from '../http/create-app.js';
import { createDatabasePool } from '../persistence/pool.js';
import { createDbReadiness } from '../persistence/readiness.js';
import {
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../persistence/test-database.js';
import { createDb } from '../../prisma/db.js';
import { createAuthRuntime } from './runtime.js';

const TEST_SECRET = 'roomies_test_secret_32_chars_minimum_value';
const TRUSTED_ORIGIN = 'http://localhost:5173';
const PASSWORD = 'test-password-only';
const NEW_PASSWORD = 'replacement-password-ok';
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
    email: { provider: 'fake' },
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

function resetBody(text: string): { status?: boolean; message?: string } {
  return JSON.parse(text) as { status?: boolean; message?: string };
}

void describe('Better Auth password reset HTTP', () => {
  void it(
    'requests, emails, resets, and revokes sessions without enumerating accounts',
    {
      skip: skipWithoutDatabase,
      timeout: 60_000,
    },
    async () => {
      const databaseUrl = resolveSafeDedicatedTestDatabaseUrl();
      const config = authConfig(databaseUrl);
      const mailbox = createFakeTransactionalEmailSender();
      const database = createDatabasePool(config);
      const db = createDb(database.pool);
      const auth = createAuthRuntime(database.pool, config, {
        emailSender: mailbox,
      });
      const identityIds: string[] = [];
      const logs: string[] = [];
      const originalError = console.error;
      const originalWarn = console.warn;
      console.error = (...args: unknown[]) => {
        logs.push(args.map((value) => JSON.stringify(value)).join(' '));
      };
      console.warn = (...args: unknown[]) => {
        logs.push(args.map((value) => JSON.stringify(value)).join(' '));
      };

      try {
        await db.connect();
        assert.equal(
          auth.options.emailAndPassword?.revokeSessionsOnPasswordReset,
          true,
        );
        const app = createApp({
          config,
          readiness: createDbReadiness(db),
          auth,
        });

        await withAppServer(app, async (request) => {
          const email = `reset-${randomUUID()}@example.test`;
          const signup = await request({
            method: 'POST',
            path: '/api/auth/sign-up/email',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              name: 'Reset Roommate',
              email,
              password: PASSWORD,
            }),
          });
          assert.ok(signup.status >= 200 && signup.status < 300);
          const identityId = (signup.json() as { user?: { id?: string } }).user
            ?.id;
          assert.ok(identityId);
          identityIds.push(identityId);
          const firstCookie = findSessionSetCookie(signup.headers);
          assert.ok(firstCookie);

          const secondSignIn = await request({
            method: 'POST',
            path: '/api/auth/sign-in/email',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ email, password: PASSWORD }),
          });
          assert.ok(secondSignIn.status >= 200 && secondSignIn.status < 300);
          const secondCookie = findSessionSetCookie(secondSignIn.headers);
          assert.ok(secondCookie);

          const unknown = await request({
            method: 'POST',
            path: '/api/auth/request-password-reset',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              email: `missing-${randomUUID()}@example.test`,
              redirectTo: `${TRUSTED_ORIGIN}/reset-password`,
            }),
          });
          assert.ok(unknown.status >= 200 && unknown.status < 300);
          const unknownBody = resetBody(unknown.text);
          assert.equal(unknownBody.status, true);
          assert.equal(mailbox.sentPasswordResets.length, 0);

          const known = await request({
            method: 'POST',
            path: '/api/auth/request-password-reset',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              email,
              redirectTo: `${TRUSTED_ORIGIN}/reset-password`,
            }),
          });
          assert.ok(known.status >= 200 && known.status < 300);
          const knownBody = resetBody(known.text);
          assert.equal(knownBody.status, true);
          assert.equal(knownBody.message, unknownBody.message);
          assert.equal(mailbox.sentPasswordResets.length, 1);
          const captured = mailbox.sentPasswordResets[0];
          assert.ok(captured);
          assert.equal(captured.to, email);
          assert.equal(captured.subject, PASSWORD_RESET_EMAIL_SUBJECT);
          const resetUrl = new URL(captured.resetUrl);
          assert.equal(resetUrl.origin, TRUSTED_ORIGIN);
          assert.equal(resetUrl.pathname, '/reset-password');
          const token = resetUrl.searchParams.get('token');
          assert.ok(token);
          assert.match(token, /^[a-zA-Z0-9]{8,64}$/);
          assert.equal(captured.text.includes(token), true);
          assert.equal(known.text.includes(token), false);
          assert.equal(unknown.text.includes(token), false);

          const invalidCallback = await request({
            method: 'GET',
            path: `/api/auth/reset-password/not-a-real-token?callbackURL=${encodeURIComponent(`${TRUSTED_ORIGIN}/reset-password`)}`,
            headers: { Origin: TRUSTED_ORIGIN },
            redirect: 'manual',
          });
          assert.ok(
            invalidCallback.status >= 300 && invalidCallback.status < 400,
          );
          const invalidLocation =
            invalidCallback.headers.get('location') ??
            invalidCallback.headers.get('Location') ??
            '';
          assert.match(invalidLocation, /error=INVALID_TOKEN/);
          assert.equal(invalidLocation.includes(token), false);

          const reset = await request({
            method: 'POST',
            path: '/api/auth/reset-password',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              token,
              newPassword: NEW_PASSWORD,
            }),
          });
          assert.ok(reset.status >= 200 && reset.status < 300);
          assert.equal(reset.text.includes(token), false);
          assert.equal(reset.text.includes(NEW_PASSWORD), false);

          const oldPassword = await request({
            method: 'POST',
            path: '/api/auth/sign-in/email',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ email, password: PASSWORD }),
          });
          assert.ok(oldPassword.status >= 400);

          const firstSession = await request({
            path: '/api/auth/get-session',
            headers: { Cookie: sessionCookieHeader(firstCookie) },
          });
          assert.equal(firstSession.text.trim(), 'null');
          const secondSession = await request({
            path: '/api/auth/get-session',
            headers: { Cookie: sessionCookieHeader(secondCookie) },
          });
          assert.equal(secondSession.text.trim(), 'null');

          const newSignIn = await request({
            method: 'POST',
            path: '/api/auth/sign-in/email',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ email, password: NEW_PASSWORD }),
          });
          assert.ok(newSignIn.status >= 200 && newSignIn.status < 300);
          const newCookie = findSessionSetCookie(newSignIn.headers);
          assert.ok(newCookie);
          const newSession = await request({
            path: '/api/auth/get-session',
            headers: { Cookie: sessionCookieHeader(newCookie) },
          });
          assert.notEqual(newSession.text.trim(), 'null');

          const reused = await request({
            method: 'POST',
            path: '/api/auth/reset-password',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              token,
              newPassword: 'another-password-ok',
            }),
          });
          assert.ok(reused.status >= 400);
          assert.equal(reused.text.includes(token), false);
        });

        assertNoForbiddenLeak({
          context: 'password-reset logs',
          text: logs.join('\n'),
          forbidden: [
            ...COMMON_SECRET_SENTINELS,
            PASSWORD,
            NEW_PASSWORD,
            TEST_SECRET,
            ...(mailbox.sentPasswordResets[0]
              ? [new URL(mailbox.sentPasswordResets[0].resetUrl).searchParams.get('token') ?? '']
              : []),
          ],
        });
      } finally {
        console.error = originalError;
        console.warn = originalWarn;
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

  void it(
    'does not reveal account existence when reset-email delivery fails',
    {
      skip: skipWithoutDatabase,
      timeout: 60_000,
    },
    async () => {
      const databaseUrl = resolveSafeDedicatedTestDatabaseUrl();
      const config = authConfig(databaseUrl);
      let capturedResetUrl = '';
      const sender: TransactionalEmailSender = {
        sendVerificationEmail() {
          return Promise.resolve();
        },
        sendPasswordResetEmail({ resetUrl }) {
          capturedResetUrl = resetUrl;
          return Promise.reject(
            new Error(`secret-provider-body token=${resetUrl}`),
          );
        },
      };
      const database = createDatabasePool(config);
      const db = createDb(database.pool);
      const auth = createAuthRuntime(database.pool, config, {
        emailSender: sender,
      });
      const identityIds: string[] = [];
      const logs: string[] = [];
      const originalError = console.error;
      const originalWarn = console.warn;
      console.error = (...args: unknown[]) => {
        logs.push(args.map((value) => JSON.stringify(value)).join(' '));
      };
      console.warn = (...args: unknown[]) => {
        logs.push(args.map((value) => JSON.stringify(value)).join(' '));
      };

      try {
        await db.connect();
        const app = createApp({
          config,
          readiness: createDbReadiness(db),
          auth,
        });

        await withAppServer(app, async (request) => {
          const email = `reset-fail-${randomUUID()}@example.test`;
          const signup = await request({
            method: 'POST',
            path: '/api/auth/sign-up/email',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              name: 'Reset Fail Roommate',
              email,
              password: PASSWORD,
            }),
          });
          assert.ok(signup.status >= 200 && signup.status < 300);
          const identityId = (signup.json() as { user?: { id?: string } }).user
            ?.id;
          assert.ok(identityId);
          identityIds.push(identityId);

          const unknown = await request({
            method: 'POST',
            path: '/api/auth/request-password-reset',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              email: `missing-${randomUUID()}@example.test`,
              redirectTo: `${TRUSTED_ORIGIN}/reset-password`,
            }),
          });
          assert.ok(unknown.status >= 200 && unknown.status < 300);
          const unknownBody = resetBody(unknown.text);

          const known = await request({
            method: 'POST',
            path: '/api/auth/request-password-reset',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              email,
              redirectTo: `${TRUSTED_ORIGIN}/reset-password`,
            }),
          });
          assert.equal(known.status, unknown.status);
          const knownBody = resetBody(known.text);
          assert.equal(knownBody.status, unknownBody.status);
          assert.equal(knownBody.message, unknownBody.message);
          assert.equal(known.text, unknown.text);
          assert.equal(capturedResetUrl.length > 0, true);
          const token =
            new URL(capturedResetUrl).searchParams.get('token') ?? '';
          assert.ok(token);
          assert.equal(known.text.includes(token), false);
          assert.equal(unknown.text.includes(token), false);
          assert.equal(known.text.includes('secret-provider-body'), false);
          assert.equal(
            logs.some((line) =>
              line.includes('[email] password-reset delivery failed'),
            ),
            true,
          );
          assertNoForbiddenLeak({
            context: 'password-reset delivery failure',
            text: `${known.text}\n${unknown.text}\n${logs.join('\n')}`,
            forbidden: [
              ...COMMON_SECRET_SENTINELS,
              PASSWORD,
              TEST_SECRET,
              token,
              capturedResetUrl,
              email,
              'secret-provider-body',
            ],
          });
        });
      } finally {
        console.error = originalError;
        console.warn = originalWarn;
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
