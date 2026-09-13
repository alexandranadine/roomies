import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AcceptInvitationInput } from '../application/invitations/accept-invitation.js';
import {
  AlreadyHomeMemberError,
  InvitationEmailMismatchError,
  InvitationEmailNotVerifiedError,
  InvitationNotAvailableError,
} from '../domains/invitations/errors.js';
import { UnauthenticatedError } from '../platform/auth/index.js';
import { appRequest } from '../platform/http/app-request.test-helper.js';
import {
  assertNoForbiddenLeak,
  COMMON_SECRET_SENTINELS,
} from '../platform/http/assert-no-forbidden-leak.js';
import { createApp } from '../platform/http/create-app.js';
import type { ApiErrorBody } from '../platform/http/errors.js';
import { createRoomiesApiRouter } from './create-roomies-api.js';
import { invitationAcceptanceDtoSchema } from './invitation-acceptance.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBERSHIP_ID = '018f1e2c-7e3a-7000-8000-1234567890ac';
const INVITATION_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TRUSTED_ORIGIN = 'http://localhost:5173';

function buildApp(options: {
  authenticated?: boolean;
  accept?: (input: AcceptInvitationInput) => Promise<{
    membershipId: string;
    homeId: string;
  }>;
}) {
  const calls: AcceptInvitationInput[] = [];
  const app = createApp({
    config: { trustedOrigins: [TRUSTED_ORIGIN], trustProxyHops: 0 },
    readiness: { checkReady: () => Promise.resolve(true) },
    roomiesApi: createRoomiesApiRouter({
      principalResolver: {
        requirePrincipal: () =>
          options.authenticated === false
            ? Promise.reject(new UnauthenticatedError())
            : Promise.resolve({ userId: USER_ID }),
      },
      activeHomeActorResolver: {
        resolve: () => Promise.reject(new Error('unexpected Home context')),
      },
      homeReader: {
        findActiveHomeById: () =>
          Promise.reject(new Error('unexpected Home read')),
      },
      archiveFinalMemberHome: () =>
        Promise.reject(new Error('unexpected archive')),
      changeMembershipRole: () =>
        Promise.reject(new Error('unexpected role change')),
      leaveMembership: () => Promise.reject(new Error('unexpected leave')),
      removeMembership: () => Promise.reject(new Error('unexpected remove')),
      acceptInvitation: async (input) => {
        calls.push(input);
        return options.accept
          ? options.accept(input)
          : { membershipId: MEMBERSHIP_ID, homeId: HOME_ID };
      },
    }),
  });
  return { app, calls };
}

function headers(overrides: Record<string, string> = {}) {
  return {
    Origin: TRUSTED_ORIGIN,
    Authorization: `Invitation ${SECRET}`,
    'content-type': 'application/json',
    ...overrides,
  };
}

function path(id = INVITATION_ID) {
  return `/api/v1/invitations/${id}/accept`;
}

void describe('POST /api/v1/invitations/:invitationId/accept', () => {
  void it('requires a Roomies session before invoking acceptance', async () => {
    const { app, calls } = buildApp({ authenticated: false });
    const response = await appRequest(app, {
      method: 'POST',
      path: path(),
      headers: headers(),
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 401);
    assert.equal(
      (response.json() as ApiErrorBody).error.code,
      'UNAUTHENTICATED',
    );
    assert.deepEqual(calls, []);
  });

  void it('requires trusted Origin before auth or handler', async () => {
    for (const origin of [undefined, 'https://evil.example']) {
      const { app, calls } = buildApp({});
      const requestHeaders = headers();
      if (origin === undefined) {
        delete (requestHeaders as Partial<typeof requestHeaders>).Origin;
      } else {
        requestHeaders.Origin = origin;
      }
      const response = await appRequest(app, {
        method: 'POST',
        path: path(),
        headers: requestHeaders,
        body: JSON.stringify({}),
      });
      assert.equal(response.status, 403);
      assert.equal((response.json() as ApiErrorBody).error.code, 'FORBIDDEN');
      assert.deepEqual(calls, []);
    }
  });

  void it('returns only the minimal 201 DTO with private no-store', async () => {
    const { app, calls } = buildApp({});
    const response = await appRequest(app, {
      method: 'POST',
      path: path(),
      headers: headers(),
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('etag'), null);
    assert.deepEqual(invitationAcceptanceDtoSchema.parse(response.json()), {
      membershipId: MEMBERSHIP_ID,
      homeId: HOME_ID,
    });
    assert.deepEqual(calls, [
      {
        invitationId: INVITATION_ID,
        userId: USER_ID,
        secret: SECRET,
      },
    ]);
    assertNoForbiddenLeak({
      context: 'acceptance success',
      text: response.text,
      forbidden: [SECRET, 'email', 'token', 'role', USER_ID],
    });
  });

  void it('accepts an empty body and rejects nonempty input', async () => {
    const missing = buildApp({});
    assert.equal(
      (
        await appRequest(missing.app, {
          method: 'POST',
          path: path(),
          headers: headers(),
        })
      ).status,
      201,
    );

    const nonempty = buildApp({});
    const response = await appRequest(nonempty.app, {
      method: 'POST',
      path: path(),
      headers: headers(),
      body: JSON.stringify({ email: 'roommate@example.com' }),
    });
    assert.equal(response.status, 400);
    assert.equal(
      (response.json() as ApiErrorBody).error.code,
      'INVALID_REQUEST',
    );
    assert.deepEqual(nonempty.calls, []);
  });

  void it('maps missing and malformed invitation credentials to generic unavailable', async () => {
    for (const authorization of [
      '',
      `Bearer ${SECRET}`,
      `invitation ${SECRET}`,
      'Invitation ',
      `Invitation ${SECRET} extra`,
    ]) {
      const { app, calls } = buildApp({});
      const response = await appRequest(app, {
        method: 'POST',
        path: path(),
        headers: headers({ Authorization: authorization }),
        body: JSON.stringify({}),
      });
      assert.equal(response.status, 404);
      assert.equal(
        (response.json() as ApiErrorBody).error.code,
        'INVITATION_NOT_AVAILABLE',
      );
      assert.deepEqual(calls, []);
      assertNoForbiddenLeak({
        context: 'malformed acceptance credential',
        text: response.text,
        forbidden: [...COMMON_SECRET_SENTINELS, SECRET],
      });
    }
  });

  void it('returns stable recipient conflicts without identity details', async () => {
    const { app } = buildApp({
      accept: () => Promise.reject(new InvitationEmailMismatchError()),
    });
    const response = await appRequest(app, {
      method: 'POST',
      path: path(),
      headers: headers(),
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 409);
    assert.equal(
      (response.json() as ApiErrorBody).error.code,
      'EMAIL_MISMATCH',
    );
    assertNoForbiddenLeak({
      context: 'email mismatch',
      text: response.text,
      forbidden: [
        ...COMMON_SECRET_SENTINELS,
        SECRET,
        'roommate@example.com',
        USER_ID,
        HOME_ID,
      ],
    });
  });

  void it('maps unverified, active-member, and unavailable failures stably', async () => {
    const cases = [
      {
        error: new InvitationEmailNotVerifiedError(),
        status: 409,
        code: 'EMAIL_NOT_VERIFIED',
      },
      {
        error: new AlreadyHomeMemberError(),
        status: 409,
        code: 'ALREADY_HOME_MEMBER',
      },
      {
        error: new InvitationNotAvailableError(),
        status: 404,
        code: 'INVITATION_NOT_AVAILABLE',
      },
    ];
    for (const testCase of cases) {
      const { app } = buildApp({
        accept: () => Promise.reject(testCase.error),
      });
      const response = await appRequest(app, {
        method: 'POST',
        path: path(),
        headers: headers(),
      });
      assert.equal(response.status, testCase.status);
      assert.equal((response.json() as ApiErrorBody).error.code, testCase.code);
      assertNoForbiddenLeak({
        context: testCase.code,
        text: response.text,
        forbidden: [SECRET, USER_ID, HOME_ID, 'token_hash'],
      });
    }
  });
});
