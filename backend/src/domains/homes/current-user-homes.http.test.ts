import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRoomiesApiRouter } from '../../http/create-roomies-api.js';
import { UnauthenticatedError } from '../../platform/auth/errors.js';
import type { PrincipalResolver } from '../../platform/auth/principal.js';
import { AuthorizationIntegrityError } from '../../platform/authz/errors.js';
import { appRequest } from '../../platform/http/app-request.test-helper.js';
import {
  assertNoForbiddenLeak,
  COMMON_SECRET_SENTINELS,
} from '../../platform/http/assert-no-forbidden-leak.js';
import { REQUEST_ID_HEADER } from '../../platform/http/constants.js';
import { createApp } from '../../platform/http/create-app.js';
import type { ApiErrorBody } from '../../platform/http/errors.js';
import type { ActiveHomeSummary } from './active-home-summary.js';
import type { ListActiveHomesCommand } from './current-user-homes-http.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SPOOFED_USER_ID = '22222222-2222-4222-8222-222222222222';
const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBERSHIP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TRUSTED_ORIGIN = 'http://localhost:5173';
const HOSTILE_ORIGIN = 'https://evil.example';

function unusedHomeDependencies() {
  return {
    activeHomeActorResolver: {
      resolve: () =>
        Promise.reject(
          new Error('home actor resolver must not run for /me/homes'),
        ),
    },
    homeReader: {
      findActiveHomeById: () =>
        Promise.reject(new Error('home reader must not run for /me/homes')),
    },
    archiveFinalMemberHome: () =>
      Promise.reject(new Error('archive must not run for /me/homes')),
    changeMembershipRole: () =>
      Promise.reject(new Error('role change must not run for /me/homes')),
    leaveMembership: () =>
      Promise.reject(new Error('leave must not run for /me/homes')),
    removeMembership: () =>
      Promise.reject(new Error('remove must not run for /me/homes')),
  };
}

function buildApp(
  options: {
    requirePrincipal?: PrincipalResolver['requirePrincipal'];
    listActiveHomes?: ListActiveHomesCommand;
  } = {},
) {
  const listCalls: { userId: string }[] = [];
  return {
    listCalls,
    app: createApp({
      config: { trustedOrigins: [TRUSTED_ORIGIN], trustProxyHops: 0 },
      readiness: { checkReady: () => Promise.resolve(true) },
      roomiesApi: createRoomiesApiRouter({
        principalResolver: {
          requirePrincipal:
            options.requirePrincipal ??
            (() => Promise.resolve({ userId: USER_ID })),
        },
        ...unusedHomeDependencies(),
        listActiveHomes: async (input) => {
          listCalls.push(input);
          if (options.listActiveHomes) {
            return options.listActiveHomes(input);
          }
          return [];
        },
      }),
    }),
  };
}

const leakSentinels = [
  ...COMMON_SECRET_SENTINELS,
  MEMBERSHIP_ID,
  'ended_at',
  'joined_at',
  'archived',
  'invitation',
  'membershipId',
  'userId',
  'SELECT',
  'stack',
];

void describe('GET /api/v1/me/homes', () => {
  void it('returns 401 without a session and does not list Homes', async () => {
    const { app, listCalls } = buildApp({
      requirePrincipal: () => Promise.reject(new UnauthenticatedError()),
    });
    const res = await appRequest(app, { path: '/api/v1/me/homes' });
    assert.equal(res.status, 401);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'UNAUTHENTICATED');
    assert.equal(body.error.message, 'Authentication required');
    assert.equal(body.error.requestId, res.headers.get(REQUEST_ID_HEADER));
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(listCalls, []);
  });

  void it('returns an empty list for a User with zero active Homes', async () => {
    const { app, listCalls } = buildApp({
      listActiveHomes: () => Promise.resolve([]),
    });
    const res = await appRequest(app, { path: '/api/v1/me/homes' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), []);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(listCalls, [{ userId: USER_ID }]);
  });

  void it('returns only the safe discovery DTO for active Homes', async () => {
    const homes: ActiveHomeSummary[] = [
      {
        id: HOME_A,
        name: 'Cedar House',
        timezone: 'UTC',
        role: 'ROOMMATE',
      },
      {
        id: HOME_B,
        name: 'Oak Street',
        timezone: 'America/Los_Angeles',
        role: 'ADMIN',
      },
    ];
    const { app } = buildApp({
      listActiveHomes: () => Promise.resolve(homes),
    });
    const res = await appRequest(app, { path: '/api/v1/me/homes' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), homes);
    assertNoForbiddenLeak({
      context: 'discovery success body',
      text: res.text,
      forbidden: leakSentinels,
    });
  });

  void it('uses the canonical User id and ignores client-supplied userId', async () => {
    const { app, listCalls } = buildApp();
    const res = await appRequest(app, {
      path: `/api/v1/me/homes?userId=${SPOOFED_USER_ID}`,
      headers: {
        'x-user-id': SPOOFED_USER_ID,
        'x-roomies-user-id': SPOOFED_USER_ID,
      },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(listCalls, [{ userId: USER_ID }]);
    assert.equal(res.text.includes(SPOOFED_USER_ID), false);
  });

  void it('does not require Origin on this GET', async () => {
    const { app } = buildApp({
      listActiveHomes: () =>
        Promise.resolve([
          {
            id: HOME_A,
            name: 'Oak Street',
            timezone: 'UTC',
            role: 'ADMIN',
          },
        ]),
    });
    const missingOrigin = await appRequest(app, { path: '/api/v1/me/homes' });
    assert.equal(missingOrigin.status, 200);
    const hostile = await appRequest(app, {
      path: '/api/v1/me/homes',
      headers: { Origin: HOSTILE_ORIGIN },
    });
    assert.equal(hostile.status, 200);
    assert.deepEqual(hostile.json(), [
      {
        id: HOME_A,
        name: 'Oak Street',
        timezone: 'UTC',
        role: 'ADMIN',
      },
    ]);
  });

  void it('maps discovery integrity failure to a safe 500', async () => {
    const { app } = buildApp({
      listActiveHomes: () => Promise.reject(new AuthorizationIntegrityError()),
    });
    const res = await appRequest(app, { path: '/api/v1/me/homes' });
    assert.equal(res.status, 500);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.equal(body.error.message, 'An unexpected error occurred');
    assertNoForbiddenLeak({
      context: 'discovery integrity 500',
      text: res.text,
      forbidden: [
        ...COMMON_SECRET_SENTINELS,
        'Authorization integrity failure',
        MEMBERSHIP_ID,
        'SELECT',
      ],
    });
  });

  void it('does not run Home-context authorization for discovery', async () => {
    const { app } = buildApp();
    const res = await appRequest(app, { path: '/api/v1/me/homes' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), []);
  });
});
