import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRoomiesApiRouter } from '../../http/create-roomies-api.js';
import { UnauthenticatedError } from '../../platform/auth/errors.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ForbiddenError } from '../../platform/authz/errors.js';
import { appRequest } from '../../platform/http/app-request.test-helper.js';
import { createApp } from '../../platform/http/create-app.js';
import type { ApiErrorBody } from '../../platform/http/errors.js';
import { FinalMemberRequiredError } from './errors.js';

const USER = '11111111-1111-4111-8111-111111111111';
const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBERSHIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function buildApp(
  options: {
    requirePrincipal?: () => Promise<{ userId: string }>;
    resolve?: () => Promise<ActiveHomeActor | null>;
    archive?: (input: {
      homeId: string;
      actor: ActiveHomeActor;
    }) => Promise<unknown>;
  } = {},
) {
  const calls: unknown[] = [];
  const actor: ActiveHomeActor = {
    userId: USER,
    homeId: HOME,
    membershipId: MEMBERSHIP,
    role: 'ROOMMATE',
  };
  return {
    calls,
    app: createApp({
      config: { trustedOrigins: [], trustProxyHops: 0 },
      readiness: { checkReady: () => Promise.resolve(true) },
      roomiesApi: createRoomiesApiRouter({
        principalResolver: {
          requirePrincipal:
            options.requirePrincipal ??
            (() => Promise.resolve({ userId: USER })),
        },
        activeHomeActorResolver: {
          resolve: options.resolve ?? (() => Promise.resolve(actor)),
        },
        homeReader: {
          findActiveHomeById: () => Promise.reject(new Error('unused')),
        },
        archiveFinalMemberHome: async (input) => {
          calls.push(input);
          return options.archive?.(input);
        },
        changeMembershipRole: () => Promise.reject(new Error('unused')),
        leaveMembership: () => Promise.reject(new Error('unused')),
        removeMembership: () => Promise.reject(new Error('unused')),
      }),
    }),
  };
}

async function post(
  app: ReturnType<typeof buildApp>['app'],
  body: string,
  homeId = HOME,
) {
  return appRequest(app, {
    method: 'POST',
    path: `/api/v1/homes/${homeId}/archive-final-member`,
    headers: { 'content-type': 'application/json' },
    body,
  });
}

void describe('POST /api/v1/homes/:homeId/archive-final-member', () => {
  void it('accepts exactly {} and returns empty private 204', async () => {
    const { app, calls } = buildApp();
    const response = await post(app, '{}');
    assert.equal(response.status, 204);
    assert.equal(response.text, '');
    assert.match(response.headers.get('cache-control') ?? '', /private/);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    assert.deepEqual(calls, [
      {
        homeId: HOME,
        actor: {
          userId: USER,
          homeId: HOME,
          membershipId: MEMBERSHIP,
          role: 'ROOMMATE',
        },
      },
    ]);
  });

  void it('rejects null, arrays, primitives, and extra fields as INVALID_REQUEST', async () => {
    for (const body of ['null', '[]', '"wrong"', '1', 'true', '{"extra":1}']) {
      const { app, calls } = buildApp();
      const response = await post(app, body);
      assert.equal(response.status, 400);
      assert.equal(
        (response.json() as ApiErrorBody).error.code,
        'INVALID_REQUEST',
      );
      assert.deepEqual(calls, []);
    }
  });

  void it('separates malformed JSON, malformed path, and authentication errors', async () => {
    let built = buildApp();
    let response = await post(built.app, '{bad');
    assert.equal((response.json() as ApiErrorBody).error.code, 'BAD_REQUEST');

    built = buildApp();
    response = await post(built.app, '{}', 'bad-id');
    assert.equal(
      (response.json() as ApiErrorBody).error.code,
      'INVALID_PATH_INPUT',
    );

    built = buildApp({
      requirePrincipal: () => Promise.reject(new UnauthenticatedError()),
    });
    response = await post(built.app, '{}');
    assert.equal(response.status, 401);
    assert.equal(
      (response.json() as ApiErrorBody).error.code,
      'UNAUTHENTICATED',
    );
  });

  void it('maps operation policy errors without legacy leave codes', async () => {
    for (const [error, status, code] of [
      [new FinalMemberRequiredError(), 409, 'FINAL_MEMBER_REQUIRED'],
      [new ForbiddenError(), 403, 'FORBIDDEN'],
    ] as const) {
      const { app } = buildApp({ archive: () => Promise.reject(error) });
      const response = await post(app, '{}');
      assert.equal(response.status, status);
      assert.equal((response.json() as ApiErrorBody).error.code, code);
    }
  });

  void it('conceals inactive actors before invoking the command', async () => {
    const { app, calls } = buildApp({ resolve: () => Promise.resolve(null) });
    const response = await post(app, '{}');
    assert.equal(response.status, 404);
    assert.equal((response.json() as ApiErrorBody).error.code, 'NOT_FOUND');
    assert.deepEqual(calls, []);
  });
});
