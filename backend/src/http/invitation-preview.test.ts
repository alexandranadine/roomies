import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvitationNotAvailableError } from '../domains/invitations/errors.js';
import { createRoomiesApiRouter } from './create-roomies-api.js';
import type { PrincipalResolver } from '../platform/auth/principal.js';
import { appRequest } from '../platform/http/app-request.test-helper.js';
import {
  assertNoForbiddenLeak,
  COMMON_SECRET_SENTINELS,
} from '../platform/http/assert-no-forbidden-leak.js';
import { createApp } from '../platform/http/create-app.js';
import type { ApiErrorBody } from '../platform/http/errors.js';
import type { PreviewInvitationInput } from '../application/invitations/preview-invitation.js';
import { invitationPreviewDtoSchema } from './invitation-preview.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBERSHIP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const INVITATION_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const OTHER_INVITATION_ID = '018f1e2c-7e3a-7000-8000-1234567890ac';
const TRUSTED_ORIGIN = 'http://localhost:5173';
const HOSTILE_ORIGIN = 'https://evil.example';
const RAW_SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const EXPIRES_AT = new Date('2026-10-08T00:00:00.000Z');

function unusedHomeReader() {
  return {
    findActiveHomeById: () =>
      Promise.reject(new Error('home reader must not run for preview HTTP')),
  };
}

function buildApp(
  options: {
    requirePrincipal?: PrincipalResolver['requirePrincipal'];
    previewInvitation?: (input: PreviewInvitationInput) => Promise<{
      invitation: {
        id: string;
        email: string;
        expiresAt: Date;
        home: { id: string; name: string };
      };
    }>;
  } = {},
) {
  const calls: PreviewInvitationInput[] = [];
  return {
    calls,
    app: createApp({
      config: { trustedOrigins: [TRUSTED_ORIGIN], trustProxyHops: 0 },
      readiness: { checkReady: () => Promise.resolve(true) },
      roomiesApi: createRoomiesApiRouter({
        principalResolver: {
          requirePrincipal:
            options.requirePrincipal ??
            (() => Promise.reject(new Error('session auth must not run'))),
        },
        activeHomeActorResolver: {
          resolve: () =>
            Promise.reject(new Error('home actor must not run for preview')),
        },
        homeReader: unusedHomeReader(),
        archiveFinalMemberHome: () =>
          Promise.reject(new Error('archive must not run for preview')),
        changeMembershipRole: () =>
          Promise.reject(new Error('role change must not run for preview')),
        leaveMembership: () =>
          Promise.reject(new Error('leave must not run for preview')),
        removeMembership: () =>
          Promise.reject(new Error('remove must not run for preview')),
        previewInvitation: async (input) => {
          calls.push(input);
          if (options.previewInvitation) {
            return options.previewInvitation(input);
          }
          return {
            invitation: {
              id: input.invitationId,
              email: 'roommate@example.com',
              expiresAt: EXPIRES_AT,
              home: { id: HOME_ID, name: 'Oak Street' },
            },
          };
        },
      }),
    }),
  };
}

function previewPath(invitationId: string = INVITATION_ID): string {
  return `/api/v1/invitations/${invitationId}/preview`;
}

function invitationHeaders(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    Origin: TRUSTED_ORIGIN,
    Authorization: `Invitation ${RAW_SECRET}`,
    'content-type': 'application/json',
    ...overrides,
  };
}

function assertUnavailable(res: {
  status: number;
  text: string;
  headers: Headers;
  json: () => unknown;
}): void {
  assert.equal(res.status, 404);
  const body = res.json() as ApiErrorBody;
  assert.equal(body.error.code, 'INVITATION_NOT_AVAILABLE');
  assert.equal(body.error.message, 'Invitation is not available');
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.equal(res.headers.get('etag'), null);
  assertNoForbiddenLeak({
    context: 'unavailable preview',
    text: res.text,
    forbidden: [
      ...COMMON_SECRET_SENTINELS,
      RAW_SECRET,
      'token_hash',
      'tokenHash',
      MEMBERSHIP_ID,
      USER_ID,
      'Authorization',
      'createdByMembershipId',
      'acceptedMembershipId',
      'photo',
      'timezone',
    ],
  });
}

void describe('POST /api/v1/invitations/:invitationId/preview', () => {
  void it('returns the safe preview DTO without session auth', async () => {
    const { app, calls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: previewPath(),
      headers: invitationHeaders(),
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.equal(res.headers.get('etag'), null);
    const body = invitationPreviewDtoSchema.parse(res.json());
    assert.deepEqual(Object.keys(body), ['invitation']);
    assert.deepEqual(Object.keys(body.invitation), [
      'id',
      'email',
      'expiresAt',
      'home',
    ]);
    assert.deepEqual(Object.keys(body.invitation.home), ['id', 'name']);
    assert.equal(body.invitation.id, INVITATION_ID);
    assert.equal(body.invitation.email, 'roommate@example.com');
    assert.equal(body.invitation.expiresAt, EXPIRES_AT.toISOString());
    assert.equal(body.invitation.home.id, HOME_ID);
    assert.equal(body.invitation.home.name, 'Oak Street');
    assert.equal('photo' in body.invitation.home, false);
    assert.equal('icon' in body.invitation.home, false);
    assert.equal('accent' in body.invitation.home, false);
    assert.equal('timezone' in body.invitation.home, false);
    assert.deepEqual(calls, [
      {
        invitationId: INVITATION_ID,
        authorization: `Invitation ${RAW_SECRET}`,
      },
    ]);
    assertNoForbiddenLeak({
      context: 'preview success',
      text: res.text,
      forbidden: [
        RAW_SECRET,
        'token_hash',
        'tokenHash',
        MEMBERSHIP_ID,
        'Authorization',
        'createdByMembershipId',
      ],
    });
  });

  void it('accepts a missing JSON body', async () => {
    const { app, calls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: previewPath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        Authorization: `Invitation ${RAW_SECRET}`,
      },
    });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
  });

  void it('does not put the secret in the URL and ignores query secrets', async () => {
    const { app, calls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: `${previewPath()}?secret=${RAW_SECRET}`,
      headers: invitationHeaders(),
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    assert.equal(calls[0]?.authorization, `Invitation ${RAW_SECRET}`);
    assert.equal(previewPath().includes(RAW_SECRET), false);
  });

  void it('maps unknown, wrong, and malformed credentials to the same unavailable result', async () => {
    const { app, calls } = buildApp({
      previewInvitation: () =>
        Promise.reject(new InvitationNotAvailableError()),
    });

    const cases: Array<Record<string, string> | undefined> = [
      invitationHeaders({ Authorization: `Invitation ${RAW_SECRET}` }),
      invitationHeaders({ Authorization: `Invitation ${'B'.repeat(43)}` }),
      invitationHeaders({ Authorization: `Bearer ${RAW_SECRET}` }),
      { Origin: TRUSTED_ORIGIN, 'content-type': 'application/json' },
      invitationHeaders({
        Authorization: `Invitation ${RAW_SECRET}, Invitation ${RAW_SECRET}`,
      }),
    ];

    for (const headers of cases) {
      const res = await appRequest(app, {
        method: 'POST',
        path: previewPath(),
        headers,
        body: JSON.stringify({}),
      });
      assertUnavailable(res);
    }
    assert.equal(calls.length, cases.length);
  });

  void it('rejects a secret in the JSON body', async () => {
    const { app, calls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: previewPath(),
      headers: invitationHeaders(),
      body: JSON.stringify({ secret: RAW_SECRET }),
    });
    assert.equal(res.status, 400);
    assert.equal((res.json() as ApiErrorBody).error.code, 'INVALID_REQUEST');
    assert.deepEqual(calls, []);
  });

  void it('rejects a hostile Origin before the preview handler', async () => {
    const { app, calls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: previewPath(),
      headers: invitationHeaders({ Origin: HOSTILE_ORIGIN }),
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 403);
    assert.equal((res.json() as ApiErrorBody).error.code, 'FORBIDDEN');
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(res.text.includes(HOSTILE_ORIGIN), false);
    assert.deepEqual(calls, []);
  });

  void it('rejects a missing Origin before the preview handler', async () => {
    const { app, calls } = buildApp();
    const headers = invitationHeaders();
    delete headers.Origin;
    const res = await appRequest(app, {
      method: 'POST',
      path: previewPath(),
      headers,
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 403);
    assert.equal((res.json() as ApiErrorBody).error.code, 'FORBIDDEN');
    assert.deepEqual(calls, []);
  });

  void it('does not let a signed-in principal broaden the DTO', async () => {
    const { app } = buildApp();
    const signedOut = await appRequest(app, {
      method: 'POST',
      path: previewPath(),
      headers: invitationHeaders(),
      body: JSON.stringify({}),
    });
    const signedIn = await appRequest(app, {
      method: 'POST',
      path: previewPath(),
      headers: invitationHeaders({
        Cookie: 'better-auth.session_token=session',
      }),
      body: JSON.stringify({}),
    });
    assert.deepEqual(Object.keys(signedOut.json() as object), ['invitation']);
    assert.deepEqual(signedOut.json(), signedIn.json());
  });

  void it('keeps Authorization and the raw secret out of errors and logs', async () => {
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map((value) => JSON.stringify(value)).join(' '));
    };
    try {
      const { app } = buildApp({
        previewInvitation: () =>
          Promise.reject(new InvitationNotAvailableError()),
      });
      const res = await appRequest(app, {
        method: 'POST',
        path: previewPath(OTHER_INVITATION_ID),
        headers: invitationHeaders(),
        body: JSON.stringify({}),
      });
      assertUnavailable(res);
      assertNoForbiddenLeak({
        context: 'preview unavailable logs',
        text: logs.join('\n'),
        forbidden: [RAW_SECRET, 'Authorization', 'token_hash'],
      });
    } finally {
      console.error = originalError;
    }
  });

  void it('rejects a malformed invitation id as path input, not an availability oracle', async () => {
    const { app, calls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: '/api/v1/invitations/not-a-uuid/preview',
      headers: invitationHeaders(),
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.equal((res.json() as ApiErrorBody).error.code, 'INVALID_PATH_INPUT');
    assert.deepEqual(calls, []);
  });
});
