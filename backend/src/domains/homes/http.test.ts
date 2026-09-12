import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRoomiesApiRouter } from '../../http/create-roomies-api.js';
import { UnauthenticatedError } from '../../platform/auth/errors.js';
import { AuthorizationIntegrityError } from '../../platform/authz/errors.js';
import type { PrincipalResolver } from '../../platform/auth/principal.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { appRequest } from '../../platform/http/app-request.test-helper.js';
import {
  assertNoForbiddenLeak,
  COMMON_SECRET_SENTINELS,
} from '../../platform/http/assert-no-forbidden-leak.js';
import { REQUEST_ID_HEADER } from '../../platform/http/constants.js';
import { createApp } from '../../platform/http/create-app.js';
import type { ApiErrorBody } from '../../platform/http/errors.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBERSHIP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const UUID_V7 = '018f1e2c-7e3a-7000-8000-1234567890ab';
const TRUSTED_ORIGIN = 'http://localhost:5173';

function actor(role: ActiveHomeActor['role'] = 'ROOMMATE'): ActiveHomeActor {
  return {
    userId: USER_ID,
    membershipId: MEMBERSHIP_ID,
    homeId: HOME_ID,
    role,
  };
}

function buildApp(
  options: {
    requirePrincipal?: PrincipalResolver['requirePrincipal'];
    resolve?: (input: {
      userId: string;
      homeId: string;
    }) => Promise<ActiveHomeActor | null>;
    findActiveHomeById?: (homeId: string) => Promise<{
      id: string;
      name: string;
      timezone: string;
    } | null>;
  } = {},
) {
  const resolveCalls: { userId: string; homeId: string }[] = [];
  return {
    resolveCalls,
    app: createApp({
      config: { trustedOrigins: [TRUSTED_ORIGIN], trustProxyHops: 0 },
      readiness: { checkReady: () => Promise.resolve(true) },
      roomiesApi: createRoomiesApiRouter({
        principalResolver: {
          requirePrincipal:
            options.requirePrincipal ??
            (() => Promise.resolve({ userId: USER_ID })),
        },
        activeHomeActorResolver: {
          resolve: async (input) => {
            resolveCalls.push(input);
            if (options.resolve) {
              return options.resolve(input);
            }
            return actor();
          },
        },
        homeReader: {
          findActiveHomeById:
            options.findActiveHomeById ??
            ((homeId) =>
              Promise.resolve({
                id: homeId,
                name: 'Oak Street',
                timezone: 'America/Los_Angeles',
              })),
        },
        changeMembershipRole: () =>
          Promise.reject(new Error('role change must not run for home read')),
        leaveMembership: () =>
          Promise.reject(new Error('leave must not run for home read')),
      }),
    }),
  };
}

const leakSentinels = [
  ...COMMON_SECRET_SENTINELS,
  MEMBERSHIP_ID,
  'ROOMMATE',
  'ADMIN',
  'archived',
  'ended_at',
  'joined_at',
  'HOME_SCOPE_MISMATCH',
  'SELECT',
  'stack',
];

void describe('GET /api/v1/homes/:homeId', () => {
  void it('returns 401 for unauthenticated malformed UUIDs without resolving', async () => {
    const { app, resolveCalls } = buildApp({
      requirePrincipal: () => Promise.reject(new UnauthenticatedError()),
    });
    const res = await appRequest(app, { path: '/api/v1/homes/not-a-uuid' });
    assert.equal(res.status, 401);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'UNAUTHENTICATED');
    assert.deepEqual(resolveCalls, []);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
  });

  void it('returns 400 for authenticated malformed UUIDs without resolving', async () => {
    const { app, resolveCalls } = buildApp();
    const res = await appRequest(app, { path: '/api/v1/homes/not-a-uuid' });
    assert.equal(res.status, 400);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'INVALID_PATH_INPUT');
    assert.equal(body.error.message, 'Invalid path input');
    assert.deepEqual(resolveCalls, []);
  });

  void it('accepts a UUIDv7 Home id', async () => {
    const { app, resolveCalls } = buildApp({
      resolve: ({ homeId }) =>
        Promise.resolve({
          ...actor(),
          homeId,
        }),
    });
    const res = await appRequest(app, { path: `/api/v1/homes/${UUID_V7}` });
    assert.equal(res.status, 200);
    assert.deepEqual(resolveCalls, [{ userId: USER_ID, homeId: UUID_V7 }]);
    assert.deepEqual(res.json(), {
      id: UUID_V7,
      name: 'Oak Street',
      timezone: 'America/Los_Angeles',
    });
  });

  void it('returns concealed 404 when the resolver yields null', async () => {
    const { app } = buildApp({
      resolve: () => Promise.resolve(null),
    });
    const res = await appRequest(app, { path: `/api/v1/homes/${HOME_ID}` });
    assert.equal(res.status, 404);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.equal(body.error.message, 'Not found');
    assertNoForbiddenLeak({
      context: 'concealed 404 body',
      text: res.text,
      forbidden: leakSentinels,
    });
  });

  void it('returns concealed 404 when the Home is archived after resolution', async () => {
    const { app } = buildApp({
      findActiveHomeById: () => Promise.resolve(null),
    });
    const res = await appRequest(app, { path: `/api/v1/homes/${HOME_ID}` });
    assert.equal(res.status, 404);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.equal(body.error.message, 'Not found');
  });

  void it('returns concealed 404 when policy sees a Home-scope mismatch', async () => {
    const { app } = buildApp({
      resolve: () => Promise.resolve({ ...actor(), homeId: OTHER_HOME_ID }),
    });
    const res = await appRequest(app, { path: `/api/v1/homes/${HOME_ID}` });
    assert.equal(res.status, 404);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'NOT_FOUND');
  });

  void it('returns only id, name, and timezone for ROOMMATE and ADMIN', async () => {
    for (const role of ['ROOMMATE', 'ADMIN'] as const) {
      const { app } = buildApp({
        resolve: () => Promise.resolve(actor(role)),
      });
      const res = await appRequest(app, {
        path: `/api/v1/homes/${HOME_ID}`,
        headers: { Origin: TRUSTED_ORIGIN },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json(), {
        id: HOME_ID,
        name: 'Oak Street',
        timezone: 'America/Los_Angeles',
      });
      assert.equal(res.headers.get('cache-control'), 'private, no-store');
      assert.equal(res.headers.get(REQUEST_ID_HEADER)?.length, 36);
      assertNoForbiddenLeak({
        context: `${role} home read body`,
        text: res.text,
        forbidden: [
          ...COMMON_SECRET_SENTINELS,
          MEMBERSHIP_ID,
          'ROOMMATE',
          'ADMIN',
          'archived',
          'membershipId',
          'userId',
          'HOME_SCOPE_MISMATCH',
        ],
      });
    }
  });

  void it('maps resolver integrity failures to a safe 500', async () => {
    const { app } = buildApp({
      resolve: () => Promise.reject(new AuthorizationIntegrityError()),
    });
    const res = await appRequest(app, { path: `/api/v1/homes/${HOME_ID}` });
    assert.equal(res.status, 500);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.equal(body.error.message, 'An unexpected error occurred');
    assertNoForbiddenLeak({
      context: 'home integrity 500',
      text: res.text,
      forbidden: [
        ...COMMON_SECRET_SENTINELS,
        'Authorization integrity failure',
        MEMBERSHIP_ID,
        'SELECT',
      ],
    });
  });
});
