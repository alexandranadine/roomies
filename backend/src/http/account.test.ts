import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { LastAdminRequiredError } from '../domains/memberships/errors.js';
import { createAuthRuntime } from '../../auth-runtime/src/index.js';
import {
  AuthInfrastructureError,
  UnauthenticatedError,
} from '../platform/auth/errors.js';
import type { PrincipalResolver } from '../platform/auth/principal.js';
import { appRequest } from '../platform/http/app-request.test-helper.js';
import {
  assertNoForbiddenLeak,
  COMMON_SECRET_SENTINELS,
} from '../platform/http/assert-no-forbidden-leak.js';
import { REQUEST_ID_HEADER } from '../platform/http/constants.js';
import { createApp } from '../platform/http/create-app.js';
import type { ApiErrorBody } from '../platform/http/errors.js';
import type { DeleteAccountCommand } from './account.js';
import { ACCOUNT_DELETION_FRESH_SESSION_MAX_AGE_MS } from './account-deletion-fresh-session.js';
import { createRoomiesApiRouter } from './create-roomies-api.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TRUSTED_ORIGIN = 'http://localhost:5173';
const HOSTILE_ORIGIN = 'https://evil.example';
const NOW = new Date('2026-09-15T18:00:00.000Z');
const TEST_SECRET = 'roomies_test_secret_32_chars_minimum_value';

const REJECTED_BODIES: readonly unknown[] = [
  {},
  { confirmation: 'delete' },
  { confirmation: 'Delete' },
  { confirmation: ' DELETE ' },
  { confirmation: true },
  { confirmation: null },
  { confirmation: 'DELETE', extra: true },
  { userId: USER_ID, confirmation: 'DELETE' },
];

function unusedHomeDependencies() {
  return {
    activeHomeActorResolver: {
      resolve: () =>
        Promise.reject(
          new Error('home actor resolver must not run for /account'),
        ),
    },
    homeReader: {
      findActiveHomeById: () =>
        Promise.reject(new Error('home reader must not run for /account')),
    },
    archiveFinalMemberHome: () =>
      Promise.reject(new Error('archive must not run for /account')),
    changeMembershipRole: () =>
      Promise.reject(new Error('role change must not run for /account')),
    leaveMembership: () =>
      Promise.reject(new Error('leave must not run for /account')),
    removeMembership: () =>
      Promise.reject(new Error('remove must not run for /account')),
  };
}

function stubAuthRuntime() {
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

function findExpiredSessionCookie(headers: Headers): string | undefined {
  return headers.getSetCookie().find((cookie) => {
    const [pair, ...attrs] = cookie.split(';').map((part) => part.trim());
    const name = pair?.split('=', 1)[0] ?? '';
    const value = pair?.slice(name.length + 1) ?? '';
    return (
      /session_token/i.test(name) &&
      value === '' &&
      attrs.some((attr) => attr.toLowerCase() === 'max-age=0')
    );
  });
}

function buildApp(
  options: {
    requirePrincipal?: PrincipalResolver['requirePrincipal'];
    deleteAccount?: DeleteAccountCommand;
    sessionCreatedAt?: Date;
  } = {},
) {
  const calls: { userId: string }[] = [];
  const auth = stubAuthRuntime();
  const createdAt = options.sessionCreatedAt ?? NOW;
  return {
    calls,
    auth,
    app: createApp({
      config: { trustedOrigins: [TRUSTED_ORIGIN], trustProxyHops: 0 },
      readiness: { checkReady: () => Promise.resolve(true) },
      roomiesApi: createRoomiesApiRouter({
        principalResolver: {
          requirePrincipal:
            options.requirePrincipal ??
            (() =>
              Promise.resolve({
                userId: USER_ID,
                sessionCreatedAt: createdAt,
              })),
        },
        ...unusedHomeDependencies(),
        account: {
          deleteAccount: async (input) => {
            calls.push(input);
            if (options.deleteAccount) {
              return options.deleteAccount(input);
            }
            return { outcome: 'completed' };
          },
          auth,
          clock: { now: () => NOW },
        },
      }),
    }),
  };
}

function deleteHeaders(overrides: Record<string, string> = {}) {
  return {
    Origin: TRUSTED_ORIGIN,
    'content-type': 'application/json',
    ...overrides,
  };
}

async function deleteAccount(
  app: ReturnType<typeof createApp>,
  options: {
    headers?: Record<string, string>;
    body?: string;
  } = {},
) {
  return appRequest(app, {
    method: 'DELETE',
    path: '/api/v1/account',
    headers: options.headers ?? deleteHeaders(),
    body: options.body ?? JSON.stringify({ confirmation: 'DELETE' }),
  });
}

void describe('DELETE /api/v1/account', () => {
  void it('returns 204 with an expired session cookie after completed', async () => {
    const { app, calls } = buildApp();
    const res = await deleteAccount(app);
    assert.equal(res.status, 204);
    assert.equal(res.text, '');
    assert.deepEqual(calls, [{ userId: USER_ID }]);
    assert.ok(findExpiredSessionCookie(res.headers));
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
  });

  void it('returns 204 with an expired session cookie for already_deleted', async () => {
    const { app, calls } = buildApp({
      deleteAccount: () => Promise.resolve({ outcome: 'already_deleted' }),
    });
    const res = await deleteAccount(app);
    assert.equal(res.status, 204);
    assert.equal(res.text, '');
    assert.deepEqual(calls, [{ userId: USER_ID }]);
    assert.ok(findExpiredSessionCookie(res.headers));
  });

  void it('returns 401 without a session and does not invoke lifecycle', async () => {
    const { app, calls } = buildApp({
      requirePrincipal: () => Promise.reject(new UnauthenticatedError()),
    });
    const res = await deleteAccount(app);
    assert.equal(res.status, 401);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'UNAUTHENTICATED');
    assert.equal(body.error.message, 'Authentication required');
    assert.equal(body.error.requestId, res.headers.get(REQUEST_ID_HEADER));
    assert.deepEqual(calls, []);
    assert.equal(findExpiredSessionCookie(res.headers), undefined);
  });

  void it('accepts a session created now, 4m59s ago, and exactly 5 minutes ago', async () => {
    for (const ageMs of [0, 4 * 60 * 1000 + 59_000, 5 * 60 * 1000]) {
      const { app, calls } = buildApp({
        sessionCreatedAt: new Date(NOW.getTime() - ageMs),
      });
      const res = await deleteAccount(app);
      assert.equal(res.status, 204, `ageMs=${ageMs}`);
      assert.equal(calls.length, 1, `ageMs=${ageMs}`);
    }
  });

  void it('rejects a stale session 1ms past 5 minutes without lifecycle or cookie expiry', async () => {
    const { app, calls } = buildApp({
      sessionCreatedAt: new Date(
        NOW.getTime() - ACCOUNT_DELETION_FRESH_SESSION_MAX_AGE_MS - 1,
      ),
    });
    const res = await deleteAccount(app);
    assert.equal(res.status, 401);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'UNAUTHENTICATED');
    assert.equal(body.error.message, 'Authentication required');
    assert.equal(res.text.includes('createdAt'), false);
    assert.equal(res.text.includes('300000'), false);
    assert.equal(res.text.includes('stale'), false);
    assert.deepEqual(calls, []);
    assert.equal(findExpiredSessionCookie(res.headers), undefined);
  });

  void it('fails closed for a future session.createdAt', async () => {
    const { app, calls } = buildApp({
      sessionCreatedAt: new Date(NOW.getTime() + 1),
    });
    const res = await deleteAccount(app);
    assert.equal(res.status, 401);
    assert.equal((res.json() as ApiErrorBody).error.code, 'UNAUTHENTICATED');
    assert.deepEqual(calls, []);
    assert.equal(findExpiredSessionCookie(res.headers), undefined);
  });

  void it('rejects every invalid confirmation body before lifecycle', async () => {
    for (const body of REJECTED_BODIES) {
      const { app, calls } = buildApp();
      const res = await deleteAccount(app, {
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(
        (res.json() as ApiErrorBody).error.code,
        'INVALID_REQUEST',
        JSON.stringify(body),
      );
      assert.deepEqual(calls, [], JSON.stringify(body));
      assert.equal(
        findExpiredSessionCookie(res.headers),
        undefined,
        JSON.stringify(body),
      );
    }
  });

  void it('rejects untrusted, missing, and malformed Origin before lifecycle', async () => {
    const cases: Array<{
      origin?: string;
      label: string;
    }> = [
      { origin: HOSTILE_ORIGIN, label: 'hostile' },
      { origin: undefined, label: 'missing' },
      { origin: 'not-a-url', label: 'malformed' },
    ];
    for (const testCase of cases) {
      const { app, calls } = buildApp();
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (testCase.origin !== undefined) {
        headers.Origin = testCase.origin;
      }
      const res = await deleteAccount(app, { headers });
      assert.equal(res.status, 403, testCase.label);
      assert.equal(
        (res.json() as ApiErrorBody).error.code,
        'FORBIDDEN',
        testCase.label,
      );
      assert.deepEqual(calls, [], testCase.label);
      assert.equal(
        findExpiredSessionCookie(res.headers),
        undefined,
        testCase.label,
      );
    }
  });

  void it('maps LAST_ADMIN_REQUIRED to 409 without expiring the cookie', async () => {
    const { app, calls } = buildApp({
      deleteAccount: () => Promise.reject(new LastAdminRequiredError()),
    });
    const res = await deleteAccount(app);
    assert.equal(res.status, 409);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'LAST_ADMIN_REQUIRED');
    assert.equal(body.error.message, 'Last admin required');
    assert.deepEqual(calls, [{ userId: USER_ID }]);
    assert.equal(findExpiredSessionCookie(res.headers), undefined);
    assert.equal(res.text.includes('home'), false);
    assert.equal(res.text.includes('roommate'), false);
  });

  void it('maps lifecycle infrastructure failure to 500 without cookie expiry', async () => {
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map((value) => JSON.stringify(value)).join(' '));
    };
    try {
      const { app, calls } = buildApp({
        deleteAccount: () => Promise.reject(new AuthInfrastructureError()),
      });
      const res = await deleteAccount(app);
      assert.equal(res.status, 500);
      assert.equal((res.json() as ApiErrorBody).error.code, 'INTERNAL_ERROR');
      assert.deepEqual(calls, [{ userId: USER_ID }]);
      assert.equal(findExpiredSessionCookie(res.headers), undefined);
      assertNoForbiddenLeak({
        context: 'account delete 500 body',
        text: res.text,
        forbidden: [
          ...COMMON_SECRET_SENTINELS,
          'confirmation',
          'DELETE',
          USER_ID,
          'createdAt',
          TEST_SECRET,
        ],
      });
      assertNoForbiddenLeak({
        context: 'account delete 500 logs',
        text: logs.join('\n'),
        forbidden: ['confirmation', 'DELETE', USER_ID, TEST_SECRET],
      });
    } finally {
      console.error = originalError;
    }
  });

  void it('does not accept client-supplied userId or session timestamps', async () => {
    const { app, calls } = buildApp();
    const res = await deleteAccount(app, {
      headers: {
        ...deleteHeaders(),
        'x-user-id': '22222222-2222-4222-8222-222222222222',
      },
      body: JSON.stringify({ confirmation: 'DELETE' }),
    });
    assert.equal(res.status, 204);
    assert.deepEqual(calls, [{ userId: USER_ID }]);
  });
});
