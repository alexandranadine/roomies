import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { memoryAdapter } from '../../../auth-runtime/node_modules/@better-auth/memory-adapter/dist/index.mjs';
import { betterAuth } from '../../../auth-runtime/node_modules/better-auth/dist/index.mjs';
import { withAppServer } from '../http/app-request.test-helper.js';
import { createApp } from '../http/create-app.js';
import type { ApiErrorBody } from '../http/errors.js';
import { createInMemoryRateLimitRuntime } from '../http/rate-limit.js';
import type { AuthRuntime } from './runtime.js';

const TRUSTED_ORIGIN = 'http://localhost:5173';
const SECRET = 'roomies_test_secret_32_chars_minimum_value';
const PASSWORD = 'test-password-only';

const UNDEFINED_BODY =
  '[body] Invalid input: expected object, received undefined; [body] Invalid input: expected record, received undefined';

function createBoundaryAuth() {
  return betterAuth({
    baseURL: 'http://localhost:3000',
    secret: SECRET,
    trustedOrigins: [TRUSTED_ORIGIN],
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
    },
    advanced: {
      database: { generateId: 'uuid', validateSchema: false },
      disableOriginCheck: false,
    },
    rateLimit: { enabled: false },
    logger: { disabled: true },
  }) as unknown as AuthRuntime;
}

function appConfig() {
  return {
    trustedOrigins: [TRUSTED_ORIGIN],
    trustProxyHops: 0,
  };
}

function authError(text: string): { code?: string; message?: string } {
  const parsed = JSON.parse(text) as {
    code?: string;
    message?: string;
  };
  return parsed;
}

void describe('Better Auth real HTTP body boundary', () => {
  void it('parses sign-up JSON over a real TCP request', async () => {
    const app = createApp({
      config: appConfig(),
      readiness: { checkReady: () => Promise.resolve(true) },
      auth: createBoundaryAuth(),
    });
    const email = `node-body-${crypto.randomUUID()}@example.test`;

    await withAppServer(app, async (request) => {
      const missingPassword = await request({
        method: 'POST',
        path: '/api/auth/sign-up/email',
        headers: {
          Origin: TRUSTED_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Node Body', email }),
      });
      assert.equal(missingPassword.status, 400);
      const missingBody = authError(missingPassword.text);
      assert.equal(missingBody.code, 'VALIDATION_ERROR');
      assert.match(missingBody.message ?? '', /\[body\.password]/);
      assert.equal(missingBody.message?.includes(UNDEFINED_BODY), false);

      const malformed = await request({
        method: 'POST',
        path: '/api/auth/sign-up/email',
        headers: {
          Origin: TRUSTED_ORIGIN,
          'content-type': 'application/json',
        },
        body: '{',
      });
      assert.equal(malformed.status, 400);
      const malformedBody = authError(malformed.text);
      assert.equal(malformedBody.code, 'BAD_REQUEST');
      assert.equal(malformedBody.message, 'Invalid JSON in request body');

      const signup = await request({
        method: 'POST',
        path: '/api/auth/sign-up/email',
        headers: {
          Origin: TRUSTED_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Node Body',
          email,
          password: PASSWORD,
        }),
      });
      assert.equal(signup.status, 200);
      const signupBody = signup.json() as { user?: { email?: string } };
      assert.equal(signupBody.user?.email, email);
      assert.equal(signup.text.includes(UNDEFINED_BODY), false);

      const sessionCookie = signup.headers
        .getSetCookie()
        .find((cookie) => /session_token=/i.test(cookie));
      assert.ok(sessionCookie);
      const cookie = sessionCookie.split(';', 1)[0] ?? '';

      const signIn = await request({
        method: 'POST',
        path: '/api/auth/sign-in/email',
        headers: {
          Origin: TRUSTED_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email, password: PASSWORD }),
      });
      assert.equal(signIn.status, 200);
      assert.equal(signIn.text.includes(UNDEFINED_BODY), false);

      const session = await request({
        path: '/api/auth/get-session',
        headers: { Cookie: cookie },
      });
      assert.equal(session.status, 200);
      const sessionBody = session.json() as { user?: { email?: string } } | null;
      assert.equal(sessionBody?.user?.email, email);

      const untrusted = await request({
        method: 'POST',
        path: '/api/auth/sign-in/email',
        headers: {
          Origin: 'https://evil.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email, password: PASSWORD }),
      });
      assert.equal(untrusted.status, 403);
      assert.equal(untrusted.headers.get('access-control-allow-origin'), null);
      const untrustedBody = authError(untrusted.text);
      assert.equal(untrustedBody.message?.includes(UNDEFINED_BODY), false);

      const missingOrigin = await request({
        method: 'POST',
        path: '/api/auth/sign-in/email',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: PASSWORD }),
      });
      assert.equal(missingOrigin.status, 403);
    });
  });

  void it('still rate limits credential POSTs before Better Auth', async () => {
    const rateLimits = createInMemoryRateLimitRuntime({
      policies: { credential: { max: 1, windowMs: 60_000 } },
    });
    const app = createApp({
      config: appConfig(),
      readiness: { checkReady: () => Promise.resolve(true) },
      rateLimits,
      auth: createBoundaryAuth(),
    });

    try {
      await withAppServer(app, async (request) => {
        const allowed = await request({
          method: 'POST',
          path: '/api/auth/sign-up/email',
          headers: {
            Origin: TRUSTED_ORIGIN,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Limited',
            email: `limited-${crypto.randomUUID()}@example.test`,
            password: PASSWORD,
          }),
        });
        assert.equal(allowed.status, 200);

        const blocked = await request({
          method: 'POST',
          path: '/api/auth/sign-up/email',
          headers: {
            Origin: TRUSTED_ORIGIN,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Limited',
            email: `limited-${crypto.randomUUID()}@example.test`,
            password: PASSWORD,
          }),
        });
        assert.equal(blocked.status, 429);
        const body = blocked.json() as ApiErrorBody;
        assert.equal(body.error.code, 'RATE_LIMITED');

        const session = await request({ path: '/api/auth/get-session' });
        assert.equal(session.status, 200);
      });
    } finally {
      rateLimits.stop();
    }
  });
});
