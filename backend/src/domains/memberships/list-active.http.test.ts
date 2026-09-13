import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRoomiesApiRouter } from '../../http/create-roomies-api.js';
import { UnauthenticatedError } from '../../platform/auth/errors.js';
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
import type {
  ActiveHomeMembershipListItem,
  ListActiveHomeMembershipsInput,
} from './active-home-membership-list.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBERSHIP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_MEMBERSHIP_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TRUSTED_ORIGIN = 'http://localhost:5173';

function actor(role: ActiveHomeActor['role'] = 'ROOMMATE'): ActiveHomeActor {
  return {
    userId: USER_ID,
    membershipId: MEMBERSHIP_ID,
    homeId: HOME_ID,
    role,
  };
}

function unusedHomeReader() {
  return {
    findActiveHomeById: () =>
      Promise.reject(new Error('home reader must not run for membership list')),
  };
}

function buildApp(
  options: {
    requirePrincipal?: PrincipalResolver['requirePrincipal'];
    resolve?: (input: {
      userId: string;
      homeId: string;
    }) => Promise<ActiveHomeActor | null>;
    listActiveHomeMemberships?: (
      input: ListActiveHomeMembershipsInput,
    ) => Promise<readonly ActiveHomeMembershipListItem[]>;
  } = {},
) {
  const calls: ListActiveHomeMembershipsInput[] = [];
  return {
    calls,
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
          resolve:
            options.resolve ??
            (({ homeId }) => Promise.resolve({ ...actor(), homeId })),
        },
        homeReader: unusedHomeReader(),
        archiveFinalMemberHome: () =>
          Promise.reject(new Error('archive must not run for membership list')),
        changeMembershipRole: () =>
          Promise.reject(
            new Error('role change must not run for membership list'),
          ),
        leaveMembership: () =>
          Promise.reject(new Error('leave must not run for membership list')),
        removeMembership: () =>
          Promise.reject(new Error('remove must not run for membership list')),
        listActiveHomeMemberships: async (input) => {
          calls.push(input);
          if (options.listActiveHomeMemberships) {
            return options.listActiveHomeMemberships(input);
          }
          return [
            { membershipId: MEMBERSHIP_ID, name: 'Alex' },
            { membershipId: OTHER_MEMBERSHIP_ID, name: 'Jamie' },
          ];
        },
      }),
    }),
  };
}

function listPath(homeId: string = HOME_ID): string {
  return `/api/v1/homes/${homeId}/memberships`;
}

const leakSentinels = [
  ...COMMON_SECRET_SENTINELS,
  USER_ID,
  'userId',
  'email',
  'endedAt',
  'joinedAt',
  'ended_at',
  'joined_at',
  'ROOMMATE',
  'ADMIN',
  'capabilities',
  'invitation',
  'session',
  'AuthIdentity',
  'HOME_SCOPE_MISMATCH',
  'SELECT',
  'stack',
];

void describe('GET /api/v1/homes/:homeId/memberships', () => {
  void it('returns 401 without a session and does not list', async () => {
    const { app, calls } = buildApp({
      requirePrincipal: () => Promise.reject(new UnauthenticatedError()),
    });
    const res = await appRequest(app, { path: listPath() });
    assert.equal(res.status, 401);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'UNAUTHENTICATED');
    assert.deepEqual(calls, []);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
  });

  void it('returns 400 for a malformed Home id', async () => {
    const { app, calls } = buildApp();
    const res = await appRequest(app, { path: listPath('not-a-uuid') });
    assert.equal(res.status, 400);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'INVALID_PATH_INPUT');
    assert.deepEqual(calls, []);
  });

  void it('returns 404 when Home context is missing', async () => {
    const { app, calls } = buildApp({
      resolve: () => Promise.resolve(null),
    });
    const res = await appRequest(app, { path: listPath() });
    assert.equal(res.status, 404);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.equal(body.error.message, 'Not found');
    assert.deepEqual(calls, []);
    assertNoForbiddenLeak({
      context: 'concealed membership list',
      text: res.text,
      forbidden: leakSentinels,
    });
  });

  void it('returns the safe collection DTO for an active Roommate without Origin', async () => {
    const { app, calls } = buildApp();
    const res = await appRequest(app, { path: listPath() });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), {
      currentMembershipId: MEMBERSHIP_ID,
      memberships: [
        { membershipId: MEMBERSHIP_ID, name: 'Alex' },
        { membershipId: OTHER_MEMBERSHIP_ID, name: 'Jamie' },
      ],
    });
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.equal(res.headers.get(REQUEST_ID_HEADER)?.length, 36);
    assert.deepEqual(calls, [{ actor: actor(), homeId: HOME_ID }]);
    assertNoForbiddenLeak({
      context: 'roommate membership list body',
      text: res.text,
      forbidden: leakSentinels,
    });
  });

  void it('returns the same projection for an active Admin', async () => {
    const { app, calls } = buildApp({
      resolve: () => Promise.resolve(actor('ADMIN')),
    });
    const res = await appRequest(app, { path: listPath() });
    assert.equal(res.status, 200);
    const body = res.json() as {
      currentMembershipId: string;
      memberships: { membershipId: string; name: string }[];
    };
    assert.equal(body.currentMembershipId, MEMBERSHIP_ID);
    assert.deepEqual(Object.keys(body).sort(), [
      'currentMembershipId',
      'memberships',
    ]);
    assert.deepEqual(Object.keys(body.memberships[0]!).sort(), [
      'membershipId',
      'name',
    ]);
    assert.equal(calls[0]?.actor.role, 'ADMIN');
    assertNoForbiddenLeak({
      context: 'admin membership list body',
      text: res.text,
      forbidden: leakSentinels,
    });
  });

  void it('does not list a foreign Home even when the path Home id differs', async () => {
    const { app, calls } = buildApp({
      resolve: ({ homeId }) =>
        Promise.resolve(homeId === HOME_ID ? actor() : null),
    });
    const res = await appRequest(app, { path: listPath(OTHER_HOME_ID) });
    assert.equal(res.status, 404);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.equal(body.error.message, 'Not found');
    assert.deepEqual(calls, []);
  });
});
