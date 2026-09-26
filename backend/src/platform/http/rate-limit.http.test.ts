import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createAuthRuntime } from '../../../auth-runtime/src/index.js';
import type { AuthRuntime } from '../auth/runtime.js';
import { createRoomiesApiRouter } from '../../http/create-roomies-api.js';
import { appRequest, withAppServer } from './app-request.test-helper.js';
import {
  assertNoForbiddenLeak,
  COMMON_SECRET_SENTINELS,
} from './assert-no-forbidden-leak.js';
import { REQUEST_ID_HEADER } from './constants.js';
import { createApp } from './create-app.js';
import type { ApiErrorBody } from './errors.js';
import { createInMemoryRateLimitRuntime } from './rate-limit.js';

const TRUSTED_ORIGIN = 'http://localhost:5173';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INVITATION_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const OTHER_INVITATION_ID = '018f1e2c-7e3a-7000-8000-1234567890ac';
const INVITE_SECRET = 'invitation-secret-must-not-be-a-limiter-key';
const NOW = new Date('2026-09-15T18:00:00.000Z');
const TEST_SECRET = 'roomies_test_secret_32_chars_minimum_value';

function unusedHomeDependencies() {
  return {
    activeHomeActorResolver: {
      resolve: () =>
        Promise.resolve({
          userId: USER_A,
          membershipId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          homeId: HOME_ID,
          role: 'ADMIN' as const,
        }),
    },
    homeReader: {
      findActiveHomeById: () =>
        Promise.reject(new Error('home reader must not run')),
    },
    archiveFinalMemberHome: () =>
      Promise.reject(new Error('archive must not run')),
    changeMembershipRole: () =>
      Promise.reject(new Error('role change must not run')),
    leaveMembership: () => Promise.reject(new Error('leave must not run')),
    removeMembership: () => Promise.reject(new Error('remove must not run')),
  };
}

function cookieAuthRuntime() {
  const pool = {
    connect() {
      return Promise.reject(new Error('unit test has no database'));
    },
    end() {
      return Promise.resolve();
    },
    on() {
      return pool;
    },
  } as unknown as Pool;
  return createAuthRuntime({
    pool,
    baseURL: 'http://localhost:3000',
    trustedOrigins: [TRUSTED_ORIGIN],
    secret: TEST_SECRET,
    secureCookies: false,
  });
}

function stubAuth(handlerCalls: string[]) {
  return {
    handler: () => {
      handlerCalls.push('auth');
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
    api: {
      getSession: () => Promise.resolve(null),
    },
    options: {},
  } as unknown as AuthRuntime;
}

function assertRateLimited(res: {
  status: number;
  text: string;
  headers: Headers;
  json: () => unknown;
}): ApiErrorBody {
  assert.equal(res.status, 429);
  const body = res.json() as ApiErrorBody;
  assert.equal(body.error.code, 'RATE_LIMITED');
  assert.equal(body.error.message, 'Too many requests');
  assert.equal(body.error.requestId, res.headers.get(REQUEST_ID_HEADER));
  assert.match(res.headers.get('retry-after') ?? '', /^[1-9]\d*$/);
  return body;
}

void describe('HTTP rate limiting', () => {
  void it('limits credential auth POSTs and leaves session lookup unlimited', async () => {
    const handlerCalls: string[] = [];
    const rateLimits = createInMemoryRateLimitRuntime({
      policies: { credential: { max: 3, windowMs: 60_000 } },
    });
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map((value) => JSON.stringify(value)).join(' '));
    };

    try {
      const app = createApp({
        config: { trustedOrigins: [TRUSTED_ORIGIN], trustProxyHops: 0 },
        readiness: { checkReady: () => Promise.resolve(true) },
        rateLimits,
        auth: stubAuth(handlerCalls),
      });

      await withAppServer(app, async (request) => {
        for (let index = 0; index < 3; index += 1) {
          const res = await request({
            method: 'POST',
            path: '/api/auth/sign-in/email',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              email: 'anyone@example.test',
              password: 'not-a-real-password',
            }),
          });
          assert.equal(res.status, 200);
        }

        const blocked = await request({
          method: 'POST',
          path: '/api/auth/sign-in/email',
          headers: {
            Origin: TRUSTED_ORIGIN,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            email: 'other@example.test',
            password: 'also-not-real',
          }),
        });
        assertRateLimited(blocked);
        assert.equal(handlerCalls.length, 3);
        assert.equal(blocked.text.includes('anyone@example.test'), false);
        assert.equal(blocked.text.includes('other@example.test'), false);
        assert.equal(blocked.text.includes('not-a-real-password'), false);

        const signup = await request({
          method: 'POST',
          path: '/api/auth/sign-up/email',
          headers: {
            Origin: TRUSTED_ORIGIN,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Roommate',
            email: 'new@example.test',
            password: 'also-not-real',
          }),
        });
        assertRateLimited(signup);
        assert.equal(handlerCalls.length, 3);

        for (let index = 0; index < 8; index += 1) {
          const session = await request({ path: '/api/auth/get-session' });
          assert.equal(session.status, 200);
        }
        const health = await request({ path: '/health' });
        assert.equal(health.status, 200);
        assert.equal(handlerCalls.length, 11);
      });

      assertNoForbiddenLeak({
        context: 'credential limiter logs',
        text: logs.join('\n'),
        forbidden: [
          ...COMMON_SECRET_SENTINELS,
          'anyone@example.test',
          'not-a-real-password',
          'Cookie',
          'Authorization',
        ],
      });
    } finally {
      console.error = originalError;
      rateLimits.stop();
    }
  });

  void it('rate-limits send-verification-email on the credential class', async () => {
    const handlerCalls: string[] = [];
    const rateLimits = createInMemoryRateLimitRuntime({
      policies: { credential: { max: 1, windowMs: 60_000 } },
    });
    try {
      const app = createApp({
        config: { trustedOrigins: [TRUSTED_ORIGIN], trustProxyHops: 0 },
        readiness: { checkReady: () => Promise.resolve(true) },
        rateLimits,
        auth: stubAuth(handlerCalls),
      });

      await withAppServer(app, async (request) => {
        const allowed = await request({
          method: 'POST',
          path: '/api/auth/send-verification-email',
          headers: {
            Origin: TRUSTED_ORIGIN,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            email: 'anyone@example.test',
            callbackURL: 'http://localhost:5173/verify-email',
          }),
        });
        assert.equal(allowed.status, 200);

        const blocked = await request({
          method: 'POST',
          path: '/api/auth/send-verification-email',
          headers: {
            Origin: TRUSTED_ORIGIN,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            email: 'other@example.test',
            callbackURL: 'http://localhost:5173/verify-email',
          }),
        });
        assertRateLimited(blocked);
        assert.equal(handlerCalls.length, 1);
        assert.equal(blocked.text.includes('anyone@example.test'), false);
        assert.equal(blocked.text.includes('other@example.test'), false);
      });
    } finally {
      rateLimits.stop();
    }
  });

  void it('rate-limits request-password-reset on the credential class', async () => {
    const handlerCalls: string[] = [];
    const rateLimits = createInMemoryRateLimitRuntime({
      policies: { credential: { max: 1, windowMs: 60_000 } },
    });
    try {
      const app = createApp({
        config: { trustedOrigins: [TRUSTED_ORIGIN], trustProxyHops: 0 },
        readiness: { checkReady: () => Promise.resolve(true) },
        rateLimits,
        auth: stubAuth(handlerCalls),
      });

      await withAppServer(app, async (request) => {
        const allowed = await request({
          method: 'POST',
          path: '/api/auth/request-password-reset',
          headers: {
            Origin: TRUSTED_ORIGIN,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            email: 'anyone@example.test',
            redirectTo: 'http://localhost:5173/reset-password',
          }),
        });
        assert.equal(allowed.status, 200);

        const blocked = await request({
          method: 'POST',
          path: '/api/auth/request-password-reset',
          headers: {
            Origin: TRUSTED_ORIGIN,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            email: 'other@example.test',
            redirectTo: 'http://localhost:5173/reset-password',
          }),
        });
        assertRateLimited(blocked);
        assert.equal(handlerCalls.length, 1);
        assert.equal(blocked.text.includes('anyone@example.test'), false);
        assert.equal(blocked.text.includes('other@example.test'), false);
      });
    } finally {
      rateLimits.stop();
    }
  });

  void it('rate-limits account deletion before lifecycle and does not expire cookies', async () => {
    const deleteCalls: string[] = [];
    const rateLimits = createInMemoryRateLimitRuntime({
      policies: { sensitive: { max: 2, windowMs: 60_000 } },
    });
    const app = createApp({
      config: { trustedOrigins: [TRUSTED_ORIGIN], trustProxyHops: 0 },
      readiness: { checkReady: () => Promise.resolve(true) },
      rateLimits,
      roomiesApi: createRoomiesApiRouter({
        principalResolver: {
          requirePrincipal: () =>
            Promise.resolve({ userId: USER_A, sessionCreatedAt: NOW }),
        },
        ...unusedHomeDependencies(),
        rateLimits,
        account: {
          deleteAccount: (input) => {
            deleteCalls.push(input.userId);
            return Promise.resolve({ outcome: 'completed' as const });
          },
          auth: cookieAuthRuntime(),
          clock: { now: () => NOW },
        },
      }),
    });

    try {
      for (let index = 0; index < 2; index += 1) {
        const res = await appRequest(app, {
          method: 'DELETE',
          path: '/api/v1/account',
          headers: {
            Origin: TRUSTED_ORIGIN,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ confirmation: 'DELETE' }),
        });
        assert.equal(res.status, 204);
      }

      const blocked = await appRequest(app, {
        method: 'DELETE',
        path: '/api/v1/account',
        headers: {
          Origin: TRUSTED_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ confirmation: 'DELETE' }),
      });
      assertRateLimited(blocked);
      assert.equal(deleteCalls.length, 2);
      assert.equal(
        blocked.headers
          .getSetCookie()
          .some((cookie) => /session_token/i.test(cookie)),
        false,
      );
      assert.equal(blocked.text.includes(USER_A), false);
      assert.equal(blocked.text.includes('DELETE'), false);
    } finally {
      rateLimits.stop();
    }
  });

  void it('keys sensitive operations by user so another user is unaffected', async () => {
    const createCalls: string[] = [];
    let currentUser = USER_A;
    const rateLimits = createInMemoryRateLimitRuntime({
      policies: { sensitive: { max: 1, windowMs: 60_000 } },
    });
    const app = createApp({
      config: { trustedOrigins: [TRUSTED_ORIGIN], trustProxyHops: 0 },
      readiness: { checkReady: () => Promise.resolve(true) },
      rateLimits,
      roomiesApi: createRoomiesApiRouter({
        principalResolver: {
          requirePrincipal: () =>
            Promise.resolve({ userId: currentUser, sessionCreatedAt: NOW }),
        },
        ...unusedHomeDependencies(),
        rateLimits,
        invitations: {
          frontendOrigin: TRUSTED_ORIGIN,
          createInvitation: () => {
            createCalls.push(currentUser);
            return Promise.resolve({
              invitation: {
                id: INVITATION_ID,
                email: 'roommate@example.test',
                expiresAt: NOW,
              },
              rawSecret: INVITE_SECRET,
            });
          },
          revokeInvitation: () =>
            Promise.reject(new Error('revoke must not run')),
        },
      }),
    });

    try {
      const first = await appRequest(app, {
        method: 'POST',
        path: `/api/v1/homes/${HOME_ID}/invitations`,
        headers: {
          Origin: TRUSTED_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email: 'roommate@example.test' }),
      });
      assert.equal(first.status, 201);

      const blocked = await appRequest(app, {
        method: 'POST',
        path: `/api/v1/homes/${HOME_ID}/invitations`,
        headers: {
          Origin: TRUSTED_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email: 'roommate@example.test' }),
      });
      assertRateLimited(blocked);
      assert.equal(blocked.text.includes(INVITE_SECRET), false);
      assert.equal(blocked.text.includes('roommate@example.test'), false);

      currentUser = USER_B;
      const otherUser = await appRequest(app, {
        method: 'POST',
        path: `/api/v1/homes/${HOME_ID}/invitations`,
        headers: {
          Origin: TRUSTED_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email: 'other@example.test' }),
      });
      assert.equal(otherUser.status, 201);
      assert.deepEqual(createCalls, [USER_A, USER_B]);
    } finally {
      rateLimits.stop();
    }
  });

  void it('limits invitation preview the same for valid and invalid tokens without using the secret as a key', async () => {
    const previewCalls: Array<{
      invitationId: string;
      authorization?: string;
    }> = [];
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map((value) => JSON.stringify(value)).join(' '));
    };
    const rateLimits = createInMemoryRateLimitRuntime({
      policies: { invitation_token: { max: 2, windowMs: 60_000 } },
    });
    const app = createApp({
      config: { trustedOrigins: [TRUSTED_ORIGIN], trustProxyHops: 0 },
      readiness: { checkReady: () => Promise.resolve(true) },
      rateLimits,
      roomiesApi: createRoomiesApiRouter({
        principalResolver: {
          requirePrincipal: () =>
            Promise.reject(new Error('preview is not session-authenticated')),
        },
        ...unusedHomeDependencies(),
        rateLimits,
        previewInvitation: (input) => {
          previewCalls.push(input);
          return Promise.resolve({
            invitation: {
              id: input.invitationId,
              email: 'roommate@example.test',
              expiresAt: NOW,
              home: { id: HOME_ID, name: 'Home' },
            },
          });
        },
      }),
    });

    try {
      const valid = await appRequest(app, {
        method: 'POST',
        path: `/api/v1/invitations/${INVITATION_ID}/preview`,
        headers: {
          Origin: TRUSTED_ORIGIN,
          Authorization: `Invitation ${INVITE_SECRET}`,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      assert.equal(valid.status, 200);

      const invalid = await appRequest(app, {
        method: 'POST',
        path: `/api/v1/invitations/${OTHER_INVITATION_ID}/preview`,
        headers: {
          Origin: TRUSTED_ORIGIN,
          Authorization: 'Invitation other-secret-value',
          'content-type': 'application/json',
        },
        body: '{}',
      });
      assert.equal(invalid.status, 200);

      const blockedValid = await appRequest(app, {
        method: 'POST',
        path: `/api/v1/invitations/${INVITATION_ID}/preview`,
        headers: {
          Origin: TRUSTED_ORIGIN,
          Authorization: `Invitation ${INVITE_SECRET}`,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      const blockedInvalid = await appRequest(app, {
        method: 'POST',
        path: `/api/v1/invitations/${OTHER_INVITATION_ID}/preview`,
        headers: {
          Origin: TRUSTED_ORIGIN,
          Authorization: 'Invitation other-secret-value',
          'content-type': 'application/json',
        },
        body: '{}',
      });
      assertRateLimited(blockedValid);
      assertRateLimited(blockedInvalid);
      assert.equal(previewCalls.length, 2);
      assert.equal(blockedValid.text.includes(INVITE_SECRET), false);
      assertNoForbiddenLeak({
        context: 'invitation limiter logs',
        text: logs.join('\n'),
        forbidden: [INVITE_SECRET, 'other-secret-value', 'Authorization'],
      });
    } finally {
      console.error = originalError;
      rateLimits.stop();
    }
  });
});
