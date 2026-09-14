import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GetHousePulseInput } from '../../application/pulse/get-house-pulse.js';
import { createRoomiesApiRouter } from '../../http/create-roomies-api.js';
import { UnauthenticatedError } from '../../platform/auth/errors.js';
import type { PrincipalResolver } from '../../platform/auth/principal.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import { appRequest } from '../../platform/http/app-request.test-helper.js';
import { createApp } from '../../platform/http/create-app.js';
import type { ApiErrorBody } from '../../platform/http/errors.js';
import { parseHomeLocalDate } from '../tasks/home-local-date.js';
import type { HousePulse } from './house-pulse.js';
import { housePulseDtoSchema } from './house-pulse-dto.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBERSHIP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TRUSTED_ORIGIN = 'http://localhost:5173';
const HOSTILE_ORIGIN = 'https://evil.example';
const GENERATED = new Date('2026-09-14T07:00:00.000Z');

function actor(role: ActiveHomeActor['role'] = 'ROOMMATE'): ActiveHomeActor {
  return {
    userId: USER_ID,
    membershipId: MEMBERSHIP_ID,
    homeId: HOME_ID,
    role,
  };
}

function emptyPulse(): HousePulse {
  return {
    generatedAt: GENERATED,
    homeLocalDate: parseHomeLocalDate('2026-09-14'),
    items: [
      {
        type: 'TASKS',
        state: 'CLEAR',
        assignedOpenCount: 0,
        unassignedOpenCount: 0,
        dueTodayRelevantCount: 0,
        overdueRelevantCount: 0,
      },
      {
        type: 'SUPPLIES',
        state: 'CLEAR',
        openCount: 0,
        unclaimedOpenCount: 0,
        claimedByMeCount: 0,
      },
      {
        type: 'MAINTENANCE',
        state: 'CLEAR',
        openVisibleCount: 0,
      },
    ],
  };
}

function unusedHomeReader() {
  return {
    findActiveHomeById: () =>
      Promise.reject(new Error('home reader must not run for pulse')),
  };
}

function buildApp(
  options: {
    requirePrincipal?: PrincipalResolver['requirePrincipal'];
    resolve?: (input: {
      userId: string;
      homeId: string;
    }) => Promise<ActiveHomeActor | null>;
    getHousePulse?: (input: GetHousePulseInput) => Promise<HousePulse>;
    role?: ActiveHomeActor['role'];
  } = {},
) {
  const pulseCalls: GetHousePulseInput[] = [];
  return {
    pulseCalls,
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
            (({ homeId }) =>
              Promise.resolve({ ...actor(options.role), homeId })),
        },
        homeReader: unusedHomeReader(),
        archiveFinalMemberHome: () =>
          Promise.reject(new Error('archive must not run for pulse')),
        changeMembershipRole: () =>
          Promise.reject(new Error('role change must not run for pulse')),
        leaveMembership: () =>
          Promise.reject(new Error('leave must not run for pulse')),
        removeMembership: () =>
          Promise.reject(new Error('remove must not run for pulse')),
        pulse: {
          getHousePulse: async (input) => {
            pulseCalls.push(input);
            if (options.getHousePulse) {
              return options.getHousePulse(input);
            }
            return emptyPulse();
          },
        },
      }),
    }),
  };
}

function pulsePath(homeId = HOME_ID): string {
  return `/api/v1/homes/${homeId}/pulse`;
}

async function getPulse(
  app: ReturnType<typeof createApp>,
  options: {
    homeId?: string;
    origin?: string | null;
    cookie?: string;
    body?: string;
  } = {},
) {
  const headers: Record<string, string> = {};
  if (options.origin !== null) {
    headers.Origin = options.origin ?? TRUSTED_ORIGIN;
  }
  if (options.cookie !== undefined) {
    headers.Cookie = options.cookie;
  }
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  return appRequest(app, {
    method: 'GET',
    path: pulsePath(options.homeId),
    headers,
    ...(options.body !== undefined ? { body: options.body } : {}),
  });
}

void describe('GET /api/v1/homes/:homeId/pulse', () => {
  void it('returns 200 with the exact Pulse DTO and private/no-store headers', async () => {
    const { app, pulseCalls } = buildApp();
    const res = await getPulse(app);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const body = housePulseDtoSchema.parse(res.json());
    assert.deepEqual(Object.keys(body), [
      'generatedAt',
      'homeLocalDate',
      'items',
    ]);
    assert.equal(body.items.length, 3);
    assert.deepEqual(
      body.items.map((item) => item.type),
      ['TASKS', 'SUPPLIES', 'MAINTENANCE'],
    );
    assert.equal(JSON.stringify(body).includes(MEMBERSHIP_ID), false);
    assert.equal(JSON.stringify(body).includes(USER_ID), false);
    assert.deepEqual(pulseCalls[0], {
      actor: actor(),
      homeId: HOME_ID,
    });
  });

  void it('uses the same DTO contract for ROOMMATE and ADMIN', async () => {
    const roommate = buildApp({ role: 'ROOMMATE' });
    const admin = buildApp({ role: 'ADMIN' });
    const roommateRes = await getPulse(roommate.app);
    const adminRes = await getPulse(admin.app);
    assert.equal(roommateRes.status, 200);
    assert.equal(adminRes.status, 200);
    assert.deepEqual(roommateRes.json(), adminRes.json());
    assert.equal(roommate.pulseCalls[0]?.actor.role, 'ROOMMATE');
    assert.equal(admin.pulseCalls[0]?.actor.role, 'ADMIN');
  });

  void it('does not depend on a request body', async () => {
    const { app, pulseCalls } = buildApp();
    const res = await getPulse(app);
    assert.equal(res.status, 200);
    assert.deepEqual(pulseCalls[0], {
      actor: actor(),
      homeId: HOME_ID,
    });
    assert.equal('body' in (pulseCalls[0] ?? {}), false);
  });

  void it('does not require a mutation Origin', async () => {
    const { app, pulseCalls } = buildApp();
    const missing = await getPulse(app, { origin: null });
    assert.equal(missing.status, 200);
    const hostile = await getPulse(app, { origin: HOSTILE_ORIGIN });
    assert.equal(hostile.status, 200);
    assert.equal(pulseCalls.length, 2);
  });

  void it('returns 401 for unauthenticated Pulse requests', async () => {
    const { app, pulseCalls } = buildApp({
      requirePrincipal: () => Promise.reject(new UnauthenticatedError()),
    });
    const res = await getPulse(app);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(pulseCalls, []);
  });

  void it('conceals stale or inaccessible Home without invoking Pulse', async () => {
    const { app, pulseCalls } = buildApp({
      resolve: () => Promise.resolve(null),
    });
    const res = await getPulse(app, { homeId: OTHER_HOME_ID });
    assert.equal(res.status, 404);
    assert.equal((res.json() as ApiErrorBody).error.code, 'NOT_FOUND');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(pulseCalls, []);
  });

  void it('maps application concealment to 404', async () => {
    const { app } = buildApp({
      getHousePulse: () => Promise.reject(new ConcealedNotFoundError()),
    });
    const res = await getPulse(app);
    assert.equal(res.status, 404);
    assert.equal((res.json() as ApiErrorBody).error.code, 'NOT_FOUND');
    assert.equal((res.json() as ApiErrorBody).error.message, 'Not found');
  });
});
