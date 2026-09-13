import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AlreadyHomeMemberError,
  InvitationAlreadyPendingError,
} from '../domains/invitations/errors.js';
import { createRoomiesApiRouter } from './create-roomies-api.js';
import { UnauthenticatedError } from '../platform/auth/errors.js';
import type { PrincipalResolver } from '../platform/auth/principal.js';
import type { ActiveHomeActor } from '../platform/authz/context.js';
import { ForbiddenError } from '../platform/authz/errors.js';
import type { CreateInvitationInput } from '../application/home-administration/create-invitation.js';
import { appRequest } from '../platform/http/app-request.test-helper.js';
import {
  assertNoForbiddenLeak,
  COMMON_SECRET_SENTINELS,
} from '../platform/http/assert-no-forbidden-leak.js';
import { createApp } from '../platform/http/create-app.js';
import type { ApiErrorBody } from '../platform/http/errors.js';
import { buildInviteUrl, createdInvitationDtoSchema } from './invitations.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBERSHIP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const INVITATION_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const TRUSTED_ORIGIN = 'http://localhost:5173';
const RAW_SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const EXPIRES_AT = new Date('2026-10-08T00:00:00.000Z');

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
      Promise.reject(new Error('home reader must not run for invitations')),
  };
}

function buildApp(
  options: {
    requirePrincipal?: PrincipalResolver['requirePrincipal'];
    resolve?: (input: {
      userId: string;
      homeId: string;
    }) => Promise<ActiveHomeActor | null>;
    createInvitation?: (input: CreateInvitationInput) => Promise<{
      invitation: { id: string; email: string; expiresAt: Date };
      rawSecret: string;
    }>;
  } = {},
) {
  const calls: CreateInvitationInput[] = [];
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
          Promise.reject(new Error('archive must not run for invitations')),
        changeMembershipRole: () =>
          Promise.reject(new Error('role change must not run for invitations')),
        leaveMembership: () =>
          Promise.reject(new Error('leave must not run for invitations')),
        removeMembership: () =>
          Promise.reject(new Error('remove must not run for invitations')),
        invitations: {
          frontendOrigin: TRUSTED_ORIGIN,
          createInvitation: async (input) => {
            calls.push(input);
            if (options.createInvitation) {
              return options.createInvitation(input);
            }
            return {
              invitation: {
                id: INVITATION_ID,
                email: input.email,
                expiresAt: EXPIRES_AT,
              },
              rawSecret: RAW_SECRET,
            };
          },
          revokeInvitation: () =>
            Promise.reject(new Error('revoke must not run for create tests')),
        },
      }),
    }),
  };
}

function invitePath(homeId: string = HOME_ID): string {
  return `/api/v1/homes/${homeId}/invitations`;
}

void describe('buildInviteUrl', () => {
  void it('uses the configured frontend origin even when trustedOrigins order differs', () => {
    const url = buildInviteUrl({
      frontendOrigin: 'https://app.example.test',
      invitationId: INVITATION_ID,
      secret: RAW_SECRET,
    });
    assert.equal(
      url,
      `https://app.example.test/invitations/${INVITATION_ID}#secret=${RAW_SECRET}`,
    );
  });

  void it('normalizes a trailing slash without producing a double slash', () => {
    const url = buildInviteUrl({
      frontendOrigin: 'https://app.example.test/',
      invitationId: INVITATION_ID,
      secret: RAW_SECRET,
    });
    assert.equal(url.includes('//invitations'), false);
    assert.equal(
      url,
      `https://app.example.test/invitations/${INVITATION_ID}#secret=${RAW_SECRET}`,
    );
  });
});

void describe('POST /api/v1/homes/:homeId/invitations', () => {
  void it('returns 201 with the exact safe DTO and fragment invite URL', async () => {
    const { app, calls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: invitePath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: '  Roommate@Example.com ' }),
    });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const body = createdInvitationDtoSchema.parse(res.json());
    assert.deepEqual(Object.keys(body), ['invitation', 'inviteUrl']);
    assert.deepEqual(Object.keys(body.invitation), [
      'id',
      'email',
      'expiresAt',
    ]);
    assert.equal(body.invitation.id, INVITATION_ID);
    assert.equal(body.invitation.email, 'roommate@example.com');
    assert.equal(body.invitation.expiresAt, EXPIRES_AT.toISOString());
    assert.equal(
      body.inviteUrl,
      `${TRUSTED_ORIGIN}/invitations/${INVITATION_ID}#secret=${RAW_SECRET}`,
    );
    assert.equal(body.inviteUrl.includes('tokenHash'), false);
    assert.equal('tokenHash' in body, false);
    assert.equal('rawSecret' in body, false);
    assert.deepEqual(calls, [
      {
        actor: actor(),
        homeId: HOME_ID,
        email: 'roommate@example.com',
      },
    ]);
  });

  void it('returns 401 for unauthenticated requests without invoking the command', async () => {
    const { app, calls } = buildApp({
      requirePrincipal: () => Promise.reject(new UnauthenticatedError()),
    });
    const res = await appRequest(app, {
      method: 'POST',
      path: invitePath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: 'roommate@example.com' }),
    });
    assert.equal(res.status, 401);
    assert.equal((res.json() as ApiErrorBody).error.code, 'UNAUTHENTICATED');
    assert.deepEqual(calls, []);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
  });

  void it('maps Roommate, concealment, and conflict codes', async () => {
    const forbidden = buildApp({
      createInvitation: () => Promise.reject(new ForbiddenError()),
    });
    const concealed = buildApp({
      resolve: () => Promise.resolve(null),
    });
    const pending = buildApp({
      createInvitation: () =>
        Promise.reject(new InvitationAlreadyPendingError()),
    });
    const member = buildApp({
      createInvitation: () => Promise.reject(new AlreadyHomeMemberError()),
    });

    const roommate = await appRequest(forbidden.app, {
      method: 'POST',
      path: invitePath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: 'roommate@example.com' }),
    });
    assert.equal(roommate.status, 403);
    assert.equal((roommate.json() as ApiErrorBody).error.code, 'FORBIDDEN');

    const missing = await appRequest(concealed.app, {
      method: 'POST',
      path: invitePath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: 'roommate@example.com' }),
    });
    assert.equal(missing.status, 404);
    assert.equal((missing.json() as ApiErrorBody).error.code, 'NOT_FOUND');
    assert.deepEqual(concealed.calls, []);

    const duplicate = await appRequest(pending.app, {
      method: 'POST',
      path: invitePath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: 'roommate@example.com' }),
    });
    assert.equal(duplicate.status, 409);
    assert.equal(
      (duplicate.json() as ApiErrorBody).error.code,
      'INVITATION_ALREADY_PENDING',
    );

    const already = await appRequest(member.app, {
      method: 'POST',
      path: invitePath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: 'roommate@example.com' }),
    });
    assert.equal(already.status, 409);
    assert.equal(
      (already.json() as ApiErrorBody).error.code,
      'ALREADY_HOME_MEMBER',
    );
  });

  void it('rejects malformed JSON as BAD_REQUEST', async () => {
    const { app, calls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: invitePath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: '{"email":',
    });
    assert.equal(res.status, 400);
    assert.equal((res.json() as ApiErrorBody).error.code, 'BAD_REQUEST');
    assert.deepEqual(calls, []);
  });

  void it('rejects invalid shapes and emails as INVALID_REQUEST', async () => {
    const { app, calls } = buildApp();
    const invalidBodies = [
      null,
      [],
      'roommate@example.com',
      {},
      { email: null },
      { email: ['roommate@example.com'] },
      { email: 'roommate@example.com', role: 'ADMIN' },
      { email: 'not-an-email' },
    ];
    for (const body of invalidBodies) {
      const res = await appRequest(app, {
        method: 'POST',
        path: invitePath(),
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

  void it('does not reflect a hostile Origin', async () => {
    const { app, calls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: invitePath(),
      headers: {
        Origin: 'https://evil.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: 'roommate@example.com' }),
    });
    assert.equal(res.status, 403);
    assert.equal((res.json() as ApiErrorBody).error.code, 'FORBIDDEN');
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(res.text.includes('https://evil.example'), false);
    assert.equal(res.text.includes(TRUSTED_ORIGIN), false);
    assert.deepEqual(calls, []);
  });

  void it('keeps the raw secret out of error bodies and logs', async () => {
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map((value) => JSON.stringify(value)).join(' '));
    };
    try {
      const { app } = buildApp({
        createInvitation: () =>
          Promise.reject(new InvitationAlreadyPendingError()),
      });
      const res = await appRequest(app, {
        method: 'POST',
        path: invitePath(),
        headers: {
          Origin: TRUSTED_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email: 'roommate@example.com' }),
      });
      assert.equal(res.status, 409);
      assertNoForbiddenLeak({
        context: 'invitation conflict body',
        text: res.text,
        forbidden: [...COMMON_SECRET_SENTINELS, RAW_SECRET, 'token_hash'],
      });
      assertNoForbiddenLeak({
        context: 'invitation conflict logs',
        text: logs.join('\n'),
        forbidden: [RAW_SECRET],
      });
    } finally {
      console.error = originalError;
    }
  });
});
