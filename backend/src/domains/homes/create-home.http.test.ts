import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRoomiesApiRouter } from '../../http/create-roomies-api.js';
import { UnauthenticatedError } from '../../platform/auth/errors.js';
import type { PrincipalResolver } from '../../platform/auth/principal.js';
import { StructuralIntegrityError } from './structure-errors.js';
import { appRequest } from '../../platform/http/app-request.test-helper.js';
import {
  assertNoForbiddenLeak,
  COMMON_SECRET_SENTINELS,
} from '../../platform/http/assert-no-forbidden-leak.js';
import { REQUEST_ID_HEADER } from '../../platform/http/constants.js';
import { createApp } from '../../platform/http/create-app.js';
import type { ApiErrorBody } from '../../platform/http/errors.js';
import type { CreateHomeCommand } from './http.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const MEMBERSHIP_ID = '018f1e2c-7e3a-7000-8000-1234567890ac';
const SECOND_HOME_ID = '018f1e2c-7e3a-7000-8000-1234567890ad';
const SECOND_MEMBERSHIP_ID = '018f1e2c-7e3a-7000-8000-1234567890ae';
const TRUSTED_ORIGIN = 'http://localhost:5173';
const HOSTILE_ORIGIN = 'https://evil.example';

function unusedHomeReader() {
  return {
    findActiveHomeById: () =>
      Promise.reject(new Error('home reader must not run for home create')),
  };
}

function buildApp(
  options: {
    requirePrincipal?: PrincipalResolver['requirePrincipal'];
    createHome?: CreateHomeCommand;
  } = {},
) {
  const resolveCalls: { userId: string; homeId: string }[] = [];
  const calls: Parameters<CreateHomeCommand>[0][] = [];
  let created = 0;
  return {
    resolveCalls,
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
          resolve: (input) => {
            resolveCalls.push(input);
            return Promise.resolve(null);
          },
        },
        homeReader: unusedHomeReader(),
        createHome: async (input) => {
          calls.push(input);
          if (options.createHome) {
            return options.createHome(input);
          }
          created += 1;
          if (created === 1) {
            return {
              home: {
                id: HOME_ID,
                name: input.name,
                timezone: input.timezone,
              },
              membership: { id: MEMBERSHIP_ID, role: 'ADMIN' },
            };
          }
          return {
            home: {
              id: SECOND_HOME_ID,
              name: input.name,
              timezone: input.timezone,
            },
            membership: { id: SECOND_MEMBERSHIP_ID, role: 'ADMIN' },
          };
        },
        archiveFinalMemberHome: () =>
          Promise.reject(new Error('archive must not run for home create')),
        changeMembershipRole: () =>
          Promise.reject(new Error('role change must not run for home create')),
        leaveMembership: () =>
          Promise.reject(new Error('leave must not run for home create')),
        removeMembership: () =>
          Promise.reject(new Error('remove must not run for home create')),
      }),
    }),
  };
}

async function postHome(
  app: ReturnType<typeof createApp>,
  input: {
    origin?: string | null;
    body?: unknown;
    rawBody?: string;
  } = {},
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (input.origin !== null) {
    headers['Origin'] = input.origin ?? TRUSTED_ORIGIN;
  }
  return appRequest(app, {
    method: 'POST',
    path: '/api/v1/homes',
    headers,
    body:
      input.rawBody ??
      JSON.stringify(
        'body' in input ? input.body : { name: 'Oak Street', timezone: 'UTC' },
      ),
  });
}

void describe('POST /api/v1/homes', () => {
  void it('returns 201 with the exact safe DTO', async () => {
    const { app, calls, resolveCalls } = buildApp();
    const res = await postHome(app, {
      body: { name: '  Oak Street  ', timezone: 'America/Los_Angeles' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.match(res.headers.get(REQUEST_ID_HEADER) ?? '', /^[0-9a-f-]{36}$/i);
    assert.deepEqual(res.json(), {
      home: {
        id: HOME_ID,
        name: 'Oak Street',
        timezone: 'America/Los_Angeles',
      },
      membership: { id: MEMBERSHIP_ID, role: 'ADMIN' },
    });
    assert.deepEqual(Object.keys(res.json() as object), ['home', 'membership']);
    assert.deepEqual(calls, [
      {
        userId: USER_ID,
        name: 'Oak Street',
        timezone: 'America/Los_Angeles',
      },
    ]);
    assert.deepEqual(resolveCalls, []);
    assertNoForbiddenLeak({
      context: 'create home 201',
      text: res.text,
      forbidden: [
        ...COMMON_SECRET_SENTINELS,
        'owner',
        'founder',
        'primaryAdmin',
        'createdBy',
        'joined_at',
        'ended_at',
        'archived',
        'SELECT',
        USER_ID,
      ],
    });
  });

  void it('returns 401 for unauthenticated requests without invoking the command', async () => {
    const { app, calls } = buildApp({
      requirePrincipal: () => Promise.reject(new UnauthenticatedError()),
    });
    const res = await postHome(app);
    assert.equal(res.status, 401);
    assert.equal((res.json() as ApiErrorBody).error.code, 'UNAUTHENTICATED');
    assert.deepEqual(calls, []);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
  });

  void it('rejects a hostile Origin without invoking the command', async () => {
    const { app, calls } = buildApp();
    const res = await postHome(app, { origin: HOSTILE_ORIGIN });
    assert.equal(res.status, 403);
    assert.equal((res.json() as ApiErrorBody).error.code, 'FORBIDDEN');
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(res.text.includes(HOSTILE_ORIGIN), false);
    assert.deepEqual(calls, []);
  });

  void it('rejects a missing Origin on the mutation', async () => {
    const { app, calls } = buildApp();
    const res = await postHome(app, { origin: null });
    assert.equal(res.status, 403);
    assert.equal((res.json() as ApiErrorBody).error.code, 'FORBIDDEN');
    assert.deepEqual(calls, []);
  });

  void it('rejects empty names, invalid timezones, and unknown fields', async () => {
    const { app, calls } = buildApp();
    const invalidBodies = [
      { name: '', timezone: 'UTC' },
      { name: '   ', timezone: 'UTC' },
      { name: 'Oak Street', timezone: 'Not/A/Zone' },
      { name: 'Oak Street', timezone: 'UTC', accent: 'sage' },
      { name: 'Oak Street', timezone: 'UTC', ownerId: USER_ID },
      { timezone: 'UTC' },
      { name: 'Oak Street' },
      {},
      null,
      [],
    ];
    for (const body of invalidBodies) {
      const res = await postHome(app, { body });
      assert.equal(res.status, 400);
      assert.equal((res.json() as ApiErrorBody).error.code, 'INVALID_REQUEST');
    }
    assert.deepEqual(calls, []);
  });

  void it('allows the same User to create another Home', async () => {
    const { app, calls } = buildApp();
    const first = await postHome(app, {
      body: { name: 'Oak Street', timezone: 'UTC' },
    });
    const second = await postHome(app, {
      body: { name: 'Pine Avenue', timezone: 'UTC' },
    });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal((first.json() as { home: { id: string } }).home.id, HOME_ID);
    assert.equal(
      (second.json() as { home: { id: string } }).home.id,
      SECOND_HOME_ID,
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.userId, USER_ID);
    assert.equal(calls[1]?.userId, USER_ID);
  });

  void it('maps integrity failures to a safe 500 without leaking SQL', async () => {
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map((value) => JSON.stringify(value)).join(' '));
    };
    try {
      const { app } = buildApp({
        createHome: () => Promise.reject(new StructuralIntegrityError()),
      });
      const res = await postHome(app);
      assert.equal(res.status, 500);
      const body = res.json() as ApiErrorBody;
      assert.equal(body.error.code, 'INTERNAL_ERROR');
      assert.equal(body.error.message, 'An unexpected error occurred');
      assertNoForbiddenLeak({
        context: 'create home integrity 500',
        text: `${res.text}\n${logs.join('\n')}`,
        forbidden: [
          ...COMMON_SECRET_SENTINELS,
          'Home structure integrity failure',
          'memberships_user_id_fkey',
          'SELECT',
          'stack',
        ],
      });
    } finally {
      console.error = originalError;
    }
  });
});
