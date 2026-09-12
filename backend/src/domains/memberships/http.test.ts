import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRoomiesApiRouter } from '../../http/create-roomies-api.js';
import { UnauthenticatedError } from '../../platform/auth/errors.js';
import type { PrincipalResolver } from '../../platform/auth/principal.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { LastAdminRequiredError } from './errors.js';
import { appRequest } from '../../platform/http/app-request.test-helper.js';
import {
  assertNoForbiddenLeak,
  COMMON_SECRET_SENTINELS,
} from '../../platform/http/assert-no-forbidden-leak.js';
import { REQUEST_ID_HEADER } from '../../platform/http/constants.js';
import { createApp } from '../../platform/http/create-app.js';
import type { ApiErrorBody } from '../../platform/http/errors.js';
import type { ChangeMembershipRoleInput } from './change-role.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBERSHIP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TRUSTED_ORIGIN = 'http://localhost:5173';

function actor(role: ActiveHomeActor['role'] = 'ADMIN'): ActiveHomeActor {
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
      Promise.reject(new Error('home reader must not run for role change')),
  };
}

function buildApp(
  options: {
    requirePrincipal?: PrincipalResolver['requirePrincipal'];
    resolve?: (input: {
      userId: string;
      homeId: string;
    }) => Promise<ActiveHomeActor | null>;
    changeMembershipRole?: (
      input: ChangeMembershipRoleInput,
    ) => Promise<unknown>;
  } = {},
) {
  const calls: ChangeMembershipRoleInput[] = [];
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
        archiveFinalMemberHome: () => Promise.resolve(),
        changeMembershipRole: async (input) => {
          calls.push(input);
          if (options.changeMembershipRole) {
            return options.changeMembershipRole(input);
          }
        },
        leaveMembership: () =>
          Promise.reject(new Error('leave must not run for role change')),
        removeMembership: () =>
          Promise.reject(new Error('remove must not run for role change')),
      }),
    }),
  };
}

function rolePath(
  homeId: string = HOME_ID,
  membershipId: string = MEMBERSHIP_ID,
): string {
  return `/api/v1/homes/${homeId}/memberships/${membershipId}/role`;
}

void describe('PATCH /api/v1/homes/:homeId/memberships/:membershipId/role', () => {
  void it('returns 401 for unauthenticated requests without invoking the command', async () => {
    const { app, calls } = buildApp({
      requirePrincipal: () => Promise.reject(new UnauthenticatedError()),
    });
    const res = await appRequest(app, {
      method: 'PATCH',
      path: rolePath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ role: 'ADMIN' }),
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
      method: 'PATCH',
      path: rolePath('not-a-uuid'),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ role: 'ADMIN' }),
    });
    assert.equal(res.status, 400);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'INVALID_PATH_INPUT');
    assert.deepEqual(calls, []);
  });

  void it('returns 400 for a malformed Membership id', async () => {
    const { app, calls } = buildApp();
    const res = await appRequest(app, {
      method: 'PATCH',
      path: rolePath(HOME_ID, 'nope'),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ role: 'ADMIN' }),
    });
    assert.equal(res.status, 400);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'INVALID_PATH_INPUT');
    assert.deepEqual(calls, []);
  });

  void it('returns 400 for an invalid body role and extra fields', async () => {
    const { app, calls } = buildApp();
    const invalidBodies = [
      null,
      [],
      {},
      { role: null },
      { role: 'OWNER' },
      { role: ['ADMIN'] },
      { role: 'ADMIN', userId: USER_ID },
    ];

    for (const body of invalidBodies) {
      const res = await appRequest(app, {
        method: 'PATCH',
        path: rolePath(),
        headers: {
          Origin: TRUSTED_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400);
      const parsed = res.json() as ApiErrorBody;
      assert.equal(parsed.error.code, 'INVALID_REQUEST');
    }
    assert.deepEqual(calls, []);
  });

  void it('returns 204 with no body and still invokes the command for same-role', async () => {
    const { app, calls } = buildApp();
    const res = await appRequest(app, {
      method: 'PATCH',
      path: rolePath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ role: 'ROOMMATE' }),
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
        role: 'ROOMMATE',
      },
    ]);
  });

  void it('maps LAST_ADMIN_REQUIRED to 409', async () => {
    const { app } = buildApp({
      changeMembershipRole: () => Promise.reject(new LastAdminRequiredError()),
    });
    const res = await appRequest(app, {
      method: 'PATCH',
      path: rolePath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ role: 'ROOMMATE' }),
    });
    assert.equal(res.status, 409);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'LAST_ADMIN_REQUIRED');
    assert.equal(body.error.message, 'Last admin required');
    assertNoForbiddenLeak({
      context: 'last admin 409',
      text: res.text,
      forbidden: [...COMMON_SECRET_SENTINELS, 'SELECT', 'memberships_role'],
    });
  });
});
