import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RevokeInvitationInput } from '../application/home-administration/revoke-invitation.js';
import { InvitationNotAvailableError } from '../domains/invitations/errors.js';
import { UnauthenticatedError } from '../platform/auth/errors.js';
import type { PrincipalResolver } from '../platform/auth/principal.js';
import type { ActiveHomeActor } from '../platform/authz/context.js';
import { ForbiddenError } from '../platform/authz/errors.js';
import { appRequest } from '../platform/http/app-request.test-helper.js';
import {
  assertNoForbiddenLeak,
  COMMON_SECRET_SENTINELS,
} from '../platform/http/assert-no-forbidden-leak.js';
import { createApp } from '../platform/http/create-app.js';
import type { ApiErrorBody } from '../platform/http/errors.js';
import { createRoomiesApiRouter } from './create-roomies-api.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBERSHIP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const INVITATION_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const OTHER_INVITATION_ID = '018f1e2c-7e3a-7000-8000-1234567890ff';
const TRUSTED_ORIGIN = 'http://localhost:5173';
const INVITED_EMAIL = 'roommate@example.com';
const TOKEN_HASH_SENTINEL = 'token_hash_should_never_leak';

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
      Promise.reject(new Error('home reader must not run for revoke')),
  };
}

function buildApp(
  options: {
    requirePrincipal?: PrincipalResolver['requirePrincipal'];
    resolve?: (input: {
      userId: string;
      homeId: string;
    }) => Promise<ActiveHomeActor | null>;
    revokeInvitation?: (input: RevokeInvitationInput) => Promise<void>;
  } = {},
) {
  const calls: RevokeInvitationInput[] = [];
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
          Promise.reject(new Error('archive must not run for revoke')),
        changeMembershipRole: () =>
          Promise.reject(new Error('role change must not run for revoke')),
        leaveMembership: () =>
          Promise.reject(new Error('leave must not run for revoke')),
        removeMembership: () =>
          Promise.reject(new Error('remove must not run for revoke')),
        invitations: {
          frontendOrigin: TRUSTED_ORIGIN,
          createInvitation: () =>
            Promise.reject(new Error('create must not run for revoke tests')),
          revokeInvitation: async (input) => {
            calls.push(input);
            if (options.revokeInvitation) {
              return options.revokeInvitation(input);
            }
          },
        },
      }),
    }),
  };
}

function revokePath(
  homeId: string = HOME_ID,
  invitationId: string = INVITATION_ID,
): string {
  return `/api/v1/homes/${homeId}/invitations/${invitationId}/revoke`;
}

void describe('POST /api/v1/homes/:homeId/invitations/:invitationId/revoke', () => {
  void it('returns 204 with private no-store and no body for a pending invitation', async () => {
    const { app, calls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: revokePath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 204);
    assert.equal(res.text, '');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(calls, [
      {
        actor: actor(),
        homeId: HOME_ID,
        invitationId: INVITATION_ID,
      },
    ]);
    assert.equal('secret' in (calls[0] ?? {}), false);
  });

  void it('accepts an omitted body and rejects nonempty input', async () => {
    const omitted = buildApp();
    assert.equal(
      (
        await appRequest(omitted.app, {
          method: 'POST',
          path: revokePath(),
          headers: { Origin: TRUSTED_ORIGIN },
        })
      ).status,
      204,
    );

    const { app, calls } = buildApp();
    const invalidBodies = [
      null,
      [],
      { reason: 'mistake' },
      { invitationId: INVITATION_ID },
      { secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    ];
    for (const body of invalidBodies) {
      const res = await appRequest(app, {
        method: 'POST',
        path: revokePath(),
        headers: {
          Origin: TRUSTED_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400);
      assert.equal((res.json() as ApiErrorBody).error.code, 'INVALID_REQUEST');
    }
    assert.deepEqual(calls, []);
  });

  void it('returns 401 for unauthenticated requests without invoking the command', async () => {
    const { app, calls } = buildApp({
      requirePrincipal: () => Promise.reject(new UnauthenticatedError()),
    });
    const res = await appRequest(app, {
      method: 'POST',
      path: revokePath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 401);
    assert.equal((res.json() as ApiErrorBody).error.code, 'UNAUTHENTICATED');
    assert.deepEqual(calls, []);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
  });

  void it('rejects hostile and missing Origin before the handler', async () => {
    for (const origin of [undefined, 'https://evil.example']) {
      const { app, calls } = buildApp();
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (origin !== undefined) {
        headers.Origin = origin;
      }
      const res = await appRequest(app, {
        method: 'POST',
        path: revokePath(),
        headers,
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 403);
      assert.equal((res.json() as ApiErrorBody).error.code, 'FORBIDDEN');
      assert.deepEqual(calls, []);
    }
  });

  void it('maps Roommate, concealment, and unavailable codes without leaks', async () => {
    const forbidden = buildApp({
      revokeInvitation: () => Promise.reject(new ForbiddenError()),
    });
    const concealed = buildApp({
      resolve: () => Promise.resolve(null),
    });
    const unavailable = buildApp({
      revokeInvitation: () => Promise.reject(new InvitationNotAvailableError()),
    });

    const roommate = await appRequest(forbidden.app, {
      method: 'POST',
      path: revokePath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(roommate.status, 403);
    assert.equal((roommate.json() as ApiErrorBody).error.code, 'FORBIDDEN');

    const missing = await appRequest(concealed.app, {
      method: 'POST',
      path: revokePath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 404);
    assert.equal((missing.json() as ApiErrorBody).error.code, 'NOT_FOUND');
    assert.deepEqual(concealed.calls, []);

    const terminal = await appRequest(unavailable.app, {
      method: 'POST',
      path: revokePath(HOME_ID, OTHER_INVITATION_ID),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(terminal.status, 404);
    assert.equal(
      (terminal.json() as ApiErrorBody).error.code,
      'INVITATION_NOT_AVAILABLE',
    );

    for (const response of [roommate, missing, terminal]) {
      assertNoForbiddenLeak({
        context: 'revoke error body',
        text: response.text,
        forbidden: [
          ...COMMON_SECRET_SENTINELS,
          INVITED_EMAIL,
          TOKEN_HASH_SENTINEL,
          'tokenHash',
          'inviteUrl',
          OTHER_HOME_ID,
        ],
      });
    }
  });
});
