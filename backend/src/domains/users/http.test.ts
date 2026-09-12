import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AuthInfrastructureError,
  UnauthenticatedError,
} from '../../platform/auth/errors.js';
import type { PrincipalResolver } from '../../platform/auth/principal.js';
import { appRequest } from '../../platform/http/app-request.test-helper.js';
import {
  assertNoForbiddenLeak,
  COMMON_SECRET_SENTINELS,
} from '../../platform/http/assert-no-forbidden-leak.js';
import { REQUEST_ID_HEADER } from '../../platform/http/constants.js';
import { createApp } from '../../platform/http/create-app.js';
import type { ApiErrorBody } from '../../platform/http/errors.js';
import { createRoomiesApiRouter } from '../../http/create-roomies-api.js';

const CANONICAL_USER_ID = '11111111-1111-4111-8111-111111111111';
const SPOOFED_USER_ID = '22222222-2222-4222-8222-222222222222';
const TRUSTED_ORIGIN = 'http://localhost:5173';

function stubResolver(
  requirePrincipal: PrincipalResolver['requirePrincipal'],
): Pick<PrincipalResolver, 'requirePrincipal'> {
  return { requirePrincipal };
}

function unusedHomeDependencies() {
  return {
    activeHomeActorResolver: {
      resolve: () =>
        Promise.reject(new Error('home actor resolver must not run for /me')),
    },
    homeReader: {
      findActiveHomeById: () =>
        Promise.reject(new Error('home reader must not run for /me')),
    },
    archiveFinalMemberHome: () =>
      Promise.reject(new Error('archive must not run for /me')),
    changeMembershipRole: () =>
      Promise.reject(new Error('role change must not run for /me')),
    leaveMembership: () =>
      Promise.reject(new Error('leave must not run for /me')),
    removeMembership: () =>
      Promise.reject(new Error('remove must not run for /me')),
  };
}

function buildApp(
  requirePrincipal: PrincipalResolver['requirePrincipal'],
  readinessReady = true,
) {
  return createApp({
    config: {
      trustedOrigins: [TRUSTED_ORIGIN],
      trustProxyHops: 0,
    },
    readiness: {
      checkReady: () => Promise.resolve(readinessReady),
    },
    roomiesApi: createRoomiesApiRouter({
      principalResolver: stubResolver(requirePrincipal),
      ...unusedHomeDependencies(),
    }),
  });
}

function authenticatedResolver(): PrincipalResolver['requirePrincipal'] {
  return () => Promise.resolve({ userId: CANONICAL_USER_ID });
}

void describe('GET /api/v1/me', () => {
  void it('returns 401 Roomies envelope without a session', async () => {
    const app = buildApp(() => Promise.reject(new UnauthenticatedError()));
    const res = await appRequest(app, { path: '/api/v1/me' });
    assert.equal(res.status, 401);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'UNAUTHENTICATED');
    assert.equal(body.error.message, 'Authentication required');
    assert.equal(body.error.requestId, res.headers.get(REQUEST_ID_HEADER));
    assert.match(body.error.requestId, /^[0-9a-f-]{36}$/i);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.ok(!('user' in body));
    assert.ok(!('session' in body));
  });

  void it('returns the canonical User id and no auth fields', async () => {
    const app = buildApp(authenticatedResolver());
    const res = await appRequest(app, { path: '/api/v1/me' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), { id: CANONICAL_USER_ID });
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.match(res.headers.get(REQUEST_ID_HEADER) ?? '', /^[0-9a-f-]{36}$/i);
    assertNoForbiddenLeak({
      context: 'authenticated /me body',
      text: res.text,
      forbidden: [
        ...COMMON_SECRET_SENTINELS,
        'session',
        'token',
        'account',
        'password',
        'email',
        'membership',
        'homeId',
        'capability',
        'userId',
      ],
    });
  });

  void it('ignores client-supplied userId query and headers', async () => {
    const app = buildApp(authenticatedResolver());
    const res = await appRequest(app, {
      path: `/api/v1/me?userId=${SPOOFED_USER_ID}`,
      headers: {
        'x-user-id': SPOOFED_USER_ID,
        'x-roomies-user-id': SPOOFED_USER_ID,
      },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), { id: CANONICAL_USER_ID });
    assert.equal(res.text.includes(SPOOFED_USER_ID), false);
  });

  void it('maps canonical integrity failure to a safe 500', async () => {
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map((value) => JSON.stringify(value)).join(' '));
    };

    try {
      const app = buildApp(() => Promise.reject(new AuthInfrastructureError()));
      const res = await appRequest(app, { path: '/api/v1/me' });
      assert.equal(res.status, 500);
      const body = res.json() as ApiErrorBody;
      assert.equal(body.error.code, 'INTERNAL_ERROR');
      assert.equal(body.error.message, 'An unexpected error occurred');
      assert.equal(body.error.requestId, res.headers.get(REQUEST_ID_HEADER));
      assert.equal(res.headers.get('cache-control'), 'private, no-store');
      assertNoForbiddenLeak({
        context: 'integrity 500 body',
        text: res.text,
        forbidden: [
          ...COMMON_SECRET_SENTINELS,
          'Authentication infrastructure failure',
          'canonical',
          'users',
          'SELECT',
          'stack',
        ],
      });
      assertNoForbiddenLeak({
        context: 'integrity 500 logs',
        text: logs.join('\n'),
        forbidden: [
          ...COMMON_SECRET_SENTINELS,
          'Authentication infrastructure failure',
          'SELECT',
        ],
      });
    } finally {
      console.error = originalError;
    }
  });

  void it('keeps CORS and security headers on /api/v1/me', async () => {
    const app = buildApp(authenticatedResolver());
    const res = await appRequest(app, {
      path: '/api/v1/me',
      headers: { Origin: TRUSTED_ORIGIN },
    });
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get('access-control-allow-origin'),
      TRUSTED_ORIGIN,
    );
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
    assert.ok(res.headers.get('x-content-type-options'));
    assert.ok(
      res.headers.get('x-frame-options') ||
        res.headers.get('content-security-policy'),
    );
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  void it('does not require auth for health or readiness', async () => {
    const app = buildApp(
      () => Promise.reject(new UnauthenticatedError()),
      false,
    );
    const health = await appRequest(app, { path: '/health' });
    assert.equal(health.status, 200);
    assert.deepEqual(health.json(), { status: 'ok' });

    const ready = await appRequest(app, { path: '/ready' });
    assert.equal(ready.status, 503);
    assert.deepEqual(ready.json(), { status: 'not_ready' });
  });
});
