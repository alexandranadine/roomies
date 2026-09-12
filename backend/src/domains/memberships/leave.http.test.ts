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
import {
  LastAdminRequiredError,
  LastRoommateRequiresArchiveError,
} from './errors.js';
import type { LeaveMembershipInput } from './leave.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBERSHIP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
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
      Promise.reject(new Error('home reader must not run for leave')),
  };
}

function buildApp(
  options: {
    requirePrincipal?: PrincipalResolver['requirePrincipal'];
    resolve?: (input: {
      userId: string;
      homeId: string;
    }) => Promise<ActiveHomeActor | null>;
    leaveMembership?: (input: LeaveMembershipInput) => Promise<unknown>;
  } = {},
) {
  const calls: LeaveMembershipInput[] = [];
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
        changeMembershipRole: () =>
          Promise.reject(new Error('role change must not run for leave')),
        leaveMembership: async (input) => {
          calls.push(input);
          if (options.leaveMembership) {
            return options.leaveMembership(input);
          }
        },
        removeMembership: () =>
          Promise.reject(new Error('remove must not run for leave')),
      }),
    }),
  };
}

function leavePath(
  homeId: string = HOME_ID,
  membershipId: string = MEMBERSHIP_ID,
): string {
  return `/api/v1/homes/${homeId}/memberships/${membershipId}/leave`;
}

void describe('POST /api/v1/homes/:homeId/memberships/:membershipId/leave', () => {
  void it('returns 401 for unauthenticated requests without invoking the command', async () => {
    const { app, calls } = buildApp({
      requirePrincipal: () => Promise.reject(new UnauthenticatedError()),
    });
    const res = await appRequest(app, {
      method: 'POST',
      path: leavePath(),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 401);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'UNAUTHENTICATED');
    assert.deepEqual(calls, []);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
  });

  void it('returns 400 for a malformed Home id', async () => {
    const { app, calls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: leavePath('not-a-uuid'),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'INVALID_PATH_INPUT');
    assert.deepEqual(calls, []);
  });

  void it('returns 400 for a malformed Membership id', async () => {
    const { app, calls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: leavePath(HOME_ID, 'nope'),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'INVALID_PATH_INPUT');
    assert.deepEqual(calls, []);
  });

  void it('returns 400 INVALID_REQUEST for valid JSON with the wrong shape', async () => {
    const { app, calls } = buildApp();
    const invalidBodies = [null, [], { anything: true }];

    for (const body of invalidBodies) {
      const res = await appRequest(app, {
        method: 'POST',
        path: leavePath(),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400);
      const parsed = res.json() as ApiErrorBody;
      assert.equal(parsed.error.code, 'INVALID_REQUEST');
    }
    assert.deepEqual(calls, []);
  });

  void it('returns 400 BAD_REQUEST for malformed JSON syntax', async () => {
    const { app, calls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: leavePath(),
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    });
    assert.equal(res.status, 400);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'BAD_REQUEST');
    assert.equal(body.error.message, 'Invalid JSON body');
    assert.deepEqual(calls, []);
  });

  void it('returns 204 with an empty body and private/no-store headers', async () => {
    const { app, calls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: leavePath(),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 204);
    assert.equal(res.text, '');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.equal(res.headers.get(REQUEST_ID_HEADER)?.length, 36);
    assert.deepEqual(calls, [
      {
        actor: actor(),
        homeId: HOME_ID,
        membershipId: MEMBERSHIP_ID,
      },
    ]);
  });

  void it('maps LAST_ADMIN_REQUIRED to 409', async () => {
    const { app } = buildApp({
      leaveMembership: () => Promise.reject(new LastAdminRequiredError()),
    });
    const res = await appRequest(app, {
      method: 'POST',
      path: leavePath(),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 409);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'LAST_ADMIN_REQUIRED');
    assert.equal(body.error.message, 'Last admin required');
    assertNoForbiddenLeak({
      context: 'last admin leave 409',
      text: res.text,
      forbidden: [...COMMON_SECRET_SENTINELS, 'SELECT', 'memberships_role'],
    });
  });

  void it('maps LAST_ROOMMATE_REQUIRES_ARCHIVE to 409', async () => {
    const { app } = buildApp({
      leaveMembership: () =>
        Promise.reject(new LastRoommateRequiresArchiveError()),
    });
    const res = await appRequest(app, {
      method: 'POST',
      path: leavePath(),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 409);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'LAST_ROOMMATE_REQUIRES_ARCHIVE');
    assert.equal(body.error.message, 'Last roommate requires archive');
  });
});
