import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CreateMaintenanceEntryInput } from '../../application/maintenance/create-maintenance-entry.js';
import { createRoomiesApiRouter } from '../../http/create-roomies-api.js';
import { UnauthenticatedError } from '../../platform/auth/errors.js';
import type { PrincipalResolver } from '../../platform/auth/principal.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import { appRequest } from '../../platform/http/app-request.test-helper.js';
import {
  assertNoForbiddenLeak,
  COMMON_SECRET_SENTINELS,
} from '../../platform/http/assert-no-forbidden-leak.js';
import { createApp } from '../../platform/http/create-app.js';
import type { ApiErrorBody } from '../../platform/http/errors.js';
import { MAINTENANCE_DETAILS_MAX_LENGTH } from './maintenance-details.js';
import {
  maintenanceDetailDtoSchema,
  type MaintenanceDetailDto,
} from './maintenance-entry-dto.js';
import type { MaintenanceDetailProjection } from './maintenance.js';
import { MAINTENANCE_TITLE_MAX_LENGTH } from './maintenance-title.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBERSHIP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RECIPIENT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const FOREIGN_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ENTRY_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const TRUSTED_ORIGIN = 'http://localhost:5173';
const HOSTILE_ORIGIN = 'https://evil.example';
const CREATED = new Date('2026-09-13T18:00:00.000Z');

function actor(role: ActiveHomeActor['role'] = 'ROOMMATE'): ActiveHomeActor {
  return {
    userId: USER_ID,
    membershipId: MEMBERSHIP_ID,
    homeId: HOME_ID,
    role,
  };
}

function projection(
  overrides: Partial<MaintenanceDetailProjection> = {},
): MaintenanceDetailProjection {
  return {
    id: ENTRY_ID,
    title: 'Leaky faucet',
    details: 'Kitchen sink',
    status: 'OPEN',
    visibility: 'HOUSEHOLD',
    createdByMembershipId: MEMBERSHIP_ID,
    resolvedByMembershipId: null,
    resolvedAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

function unusedHomeReader() {
  return {
    findActiveHomeById: () =>
      Promise.reject(new Error('home reader must not run for maintenance')),
  };
}

function buildApp(
  options: {
    requirePrincipal?: PrincipalResolver['requirePrincipal'];
    resolve?: (input: {
      userId: string;
      homeId: string;
    }) => Promise<ActiveHomeActor | null>;
    createMaintenanceEntry?: (
      input: CreateMaintenanceEntryInput,
    ) => Promise<MaintenanceDetailProjection>;
  } = {},
) {
  const createCalls: CreateMaintenanceEntryInput[] = [];
  return {
    createCalls,
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
          Promise.reject(new Error('archive must not run for maintenance')),
        changeMembershipRole: () =>
          Promise.reject(new Error('role change must not run for maintenance')),
        leaveMembership: () =>
          Promise.reject(new Error('leave must not run for maintenance')),
        removeMembership: () =>
          Promise.reject(new Error('remove must not run for maintenance')),
        maintenance: {
          createMaintenanceEntry: async (input) => {
            createCalls.push(input);
            if (options.createMaintenanceEntry) {
              return options.createMaintenanceEntry(input);
            }
            return projection({
              title: input.title,
              details: input.details ?? null,
              visibility:
                input.visibility === 'PRIVATE' ? 'PRIVATE' : 'HOUSEHOLD',
            });
          },
        },
      }),
    }),
  };
}

function maintenancePath(homeId: string = HOME_ID): string {
  return `/api/v1/homes/${homeId}/maintenance`;
}

const dtoKeys = [
  'id',
  'title',
  'status',
  'visibility',
  'createdByMembershipId',
  'resolvedByMembershipId',
  'resolvedAt',
  'createdAt',
  'updatedAt',
  'details',
];

const leakSentinels = [
  ...COMMON_SECRET_SENTINELS,
  'audienceMembershipIds',
  'audience',
  'foreign',
  'ended',
  'membership exists',
  'userId',
  'role',
  'SELECT',
  'stack',
  RECIPIENT_ID,
  FOREIGN_ID,
];

function postCreate(
  app: ReturnType<typeof buildApp>['app'],
  body: unknown,
  options: {
    homeId?: string;
    origin?: string | null;
    cookie?: string;
  } = {},
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (options.origin !== null) {
    headers.Origin = options.origin ?? TRUSTED_ORIGIN;
  }
  if (options.cookie !== undefined) {
    headers.Cookie = options.cookie;
  }
  return appRequest(app, {
    method: 'POST',
    path: maintenancePath(options.homeId),
    headers,
    body: JSON.stringify(body),
  });
}

void describe('POST /api/v1/homes/:homeId/maintenance', () => {
  void it('returns 201 with the exact safe DTO for ROOMMATE HOUSEHOLD create', async () => {
    const { app, createCalls } = buildApp();
    const res = await postCreate(app, {
      visibility: 'HOUSEHOLD',
      title: '  Leaky faucet  ',
      details: 'Kitchen sink',
    });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const body = maintenanceDetailDtoSchema.parse(res.json());
    assert.deepEqual(Object.keys(body), dtoKeys);
    assert.equal(body.status, 'OPEN');
    assert.equal(body.visibility, 'HOUSEHOLD');
    assert.equal(body.title, 'Leaky faucet');
    assert.equal(body.details, 'Kitchen sink');
    assert.equal(body.createdByMembershipId, MEMBERSHIP_ID);
    assert.equal(body.resolvedByMembershipId, null);
    assert.equal(body.resolvedAt, null);
    assert.equal('homeId' in (res.json() as object), false);
    assert.equal('audienceMembershipIds' in (res.json() as object), false);
    assert.deepEqual(createCalls, [
      {
        actor: actor(),
        homeId: HOME_ID,
        visibility: 'HOUSEHOLD',
        title: 'Leaky faucet',
        details: 'Kitchen sink',
      },
    ]);
  });

  void it('returns 201 for ADMIN HOUSEHOLD create', async () => {
    const { app, createCalls } = buildApp({
      resolve: ({ homeId }) => Promise.resolve({ ...actor('ADMIN'), homeId }),
    });
    const res = await postCreate(app, {
      visibility: 'HOUSEHOLD',
      title: 'Admin issue',
    });
    assert.equal(res.status, 201);
    assert.equal((res.json() as MaintenanceDetailDto).visibility, 'HOUSEHOLD');
    assert.equal(createCalls[0]?.actor.role, 'ADMIN');
  });

  void it('returns 201 for ROOMMATE PRIVATE creator-only create', async () => {
    const { app, createCalls } = buildApp();
    const res = await postCreate(app, {
      visibility: 'PRIVATE',
      title: 'Private note',
      audienceMembershipIds: [],
    });
    assert.equal(res.status, 201);
    const body = maintenanceDetailDtoSchema.parse(res.json());
    assert.equal(body.visibility, 'PRIVATE');
    assert.equal('audienceMembershipIds' in (res.json() as object), false);
    assert.deepEqual(createCalls[0]?.audienceMembershipIds, []);
  });

  void it('returns 201 for ROOMMATE PRIVATE with recipient', async () => {
    const { app, createCalls } = buildApp();
    const res = await postCreate(app, {
      visibility: 'PRIVATE',
      title: 'Shared private',
      audienceMembershipIds: [RECIPIENT_ID],
    });
    assert.equal(res.status, 201);
    assert.equal('audienceMembershipIds' in (res.json() as object), false);
    assert.deepEqual(createCalls[0]?.audienceMembershipIds, [RECIPIENT_ID]);
  });

  void it('returns 201 for ADMIN PRIVATE create', async () => {
    const { app, createCalls } = buildApp({
      resolve: ({ homeId }) => Promise.resolve({ ...actor('ADMIN'), homeId }),
    });
    const res = await postCreate(app, {
      visibility: 'PRIVATE',
      title: 'Admin private',
      audienceMembershipIds: [],
    });
    assert.equal(res.status, 201);
    assert.equal(createCalls[0]?.actor.role, 'ADMIN');
  });

  void it('accepts a trusted mutation Origin', async () => {
    const { app, createCalls } = buildApp();
    const res = await postCreate(
      app,
      { visibility: 'HOUSEHOLD', title: 'Trusted' },
      { origin: TRUSTED_ORIGIN },
    );
    assert.equal(res.status, 201);
    assert.equal(createCalls.length, 1);
  });

  void it('rejects a hostile Origin without invoking the command', async () => {
    const { app, createCalls } = buildApp();
    const res = await postCreate(
      app,
      { visibility: 'HOUSEHOLD', title: 'Hostile' },
      { origin: HOSTILE_ORIGIN },
    );
    assert.equal(res.status, 403);
    assert.equal((res.json() as ApiErrorBody).error.code, 'FORBIDDEN');
    assert.deepEqual(createCalls, []);
    assert.equal(res.text.includes(HOSTILE_ORIGIN), false);
  });

  void it('rejects a missing mutation Origin without invoking the command', async () => {
    const { app, createCalls } = buildApp();
    const res = await postCreate(
      app,
      { visibility: 'HOUSEHOLD', title: 'Missing origin' },
      { origin: null },
    );
    assert.equal(res.status, 403);
    assert.equal((res.json() as ApiErrorBody).error.code, 'FORBIDDEN');
    assert.deepEqual(createCalls, []);
  });

  void it('returns 401 for unauthenticated requests without invoking the command', async () => {
    const { app, createCalls } = buildApp({
      requirePrincipal: () => Promise.reject(new UnauthenticatedError()),
    });
    const res = await postCreate(app, {
      visibility: 'HOUSEHOLD',
      title: 'No auth',
    });
    assert.equal(res.status, 401);
    assert.equal((res.json() as ApiErrorBody).error.code, 'UNAUTHENTICATED');
    assert.deepEqual(createCalls, []);
  });

  void it('rejects malformed bodies, unknown keys, and contradictory shapes', async () => {
    const { app, createCalls } = buildApp();
    const invalidBodies = [
      null,
      [],
      'title',
      {},
      { visibility: 'HOUSEHOLD' },
      { visibility: 'PUBLIC', title: 'ok' },
      { visibility: 'HOUSEHOLD', title: 1 },
      { visibility: 'HOUSEHOLD', title: 'ok', extra: 1 },
      { visibility: 'HOUSEHOLD', title: 'ok', audienceMembershipIds: [] },
      {
        visibility: 'HOUSEHOLD',
        title: 'ok',
        audienceMembershipIds: [MEMBERSHIP_ID],
      },
      { visibility: 'PRIVATE', title: 'ok' },
      { visibility: 'PRIVATE', title: 'ok', audienceMembershipIds: null },
      {
        visibility: 'PRIVATE',
        title: 'ok',
        audienceMembershipIds: ['not-a-uuid'],
      },
      { visibility: 'PRIVATE', title: 'ok', audienceMembershipIds: [123] },
      { title: 'ok' },
      { visibility: 'HOUSEHOLD', title: '   ' },
      {
        visibility: 'HOUSEHOLD',
        title: 'x'.repeat(MAINTENANCE_TITLE_MAX_LENGTH + 1),
      },
      {
        visibility: 'HOUSEHOLD',
        title: 'ok',
        details: 'x'.repeat(MAINTENANCE_DETAILS_MAX_LENGTH + 1),
      },
      {
        visibility: 'HOUSEHOLD',
        title: 'ok',
        homeId: HOME_ID,
      },
      {
        visibility: 'HOUSEHOLD',
        title: 'ok',
        id: ENTRY_ID,
      },
      {
        visibility: 'HOUSEHOLD',
        title: 'ok',
        createdByMembershipId: MEMBERSHIP_ID,
      },
    ];
    for (const body of invalidBodies) {
      const res = await postCreate(app, body);
      assert.equal(res.status, 400);
      assert.equal((res.json() as ApiErrorBody).error.code, 'INVALID_REQUEST');
    }
    assert.deepEqual(createCalls, []);
  });

  void it('conceals an inaccessible Home without invoking the command', async () => {
    const { app, createCalls } = buildApp({
      resolve: () => Promise.resolve(null),
    });
    const res = await postCreate(
      app,
      { visibility: 'HOUSEHOLD', title: 'Hidden home' },
      { homeId: OTHER_HOME_ID },
    );
    assert.equal(res.status, 404);
    assert.equal((res.json() as ApiErrorBody).error.code, 'NOT_FOUND');
    assert.deepEqual(createCalls, []);
    assertNoForbiddenLeak({
      context: 'concealed maintenance create HTTP',
      text: res.text,
      forbidden: leakSentinels,
    });
  });

  void it('maps concealed audience failures to the same generic NOT_FOUND shape', async () => {
    const concealedBodies = [
      {
        visibility: 'PRIVATE',
        title: 'Foreign',
        audienceMembershipIds: [FOREIGN_ID],
      },
      {
        visibility: 'PRIVATE',
        title: 'Ended',
        audienceMembershipIds: [RECIPIENT_ID],
      },
      {
        visibility: 'PRIVATE',
        title: 'Missing',
        audienceMembershipIds: [FOREIGN_ID],
      },
    ];
    const responses: Array<{ code: string; message: string }> = [];
    for (const body of concealedBodies) {
      const { app, createCalls } = buildApp({
        createMaintenanceEntry: () =>
          Promise.reject(new ConcealedNotFoundError()),
      });
      const res = await postCreate(app, body);
      assert.equal(res.status, 404);
      const error = (res.json() as ApiErrorBody).error;
      assert.equal(error.code, 'NOT_FOUND');
      assert.equal(error.message, 'Not found');
      assert.deepEqual(createCalls.length, 1);
      responses.push({ code: error.code, message: error.message });
    }
    assert.deepEqual(responses[0], responses[1]);
    assert.deepEqual(responses[1], responses[2]);
    assertNoForbiddenLeak({
      context: 'concealed audience maintenance create HTTP',
      text: JSON.stringify(responses),
      forbidden: leakSentinels,
    });
  });
});
