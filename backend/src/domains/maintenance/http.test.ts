import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CreateMaintenanceEntryInput } from '../../application/maintenance/create-maintenance-entry.js';
import type { ListHomeMaintenanceInput } from '../../application/maintenance/list-home-maintenance.js';
import type { ReadMaintenanceEntryInput } from '../../application/maintenance/read-maintenance-entry.js';
import { createRoomiesApiRouter } from '../../http/create-roomies-api.js';
import { UnauthenticatedError } from '../../platform/auth/errors.js';
import type { PrincipalResolver } from '../../platform/auth/principal.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  InvalidRequestError,
} from '../../platform/authz/errors.js';
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
  maintenanceListPageDtoSchema,
  type MaintenanceDetailDto,
} from './maintenance-entry-dto.js';
import type {
  MaintenanceDetailProjection,
  MaintenanceListItemProjection,
} from './maintenance.js';
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

function listItem(
  overrides: Partial<MaintenanceListItemProjection> = {},
): MaintenanceListItemProjection {
  return {
    id: ENTRY_ID,
    title: 'Leaky faucet',
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

function emptyPage(): {
  items: readonly MaintenanceListItemProjection[];
  hasMore: boolean;
  nextCursor: string | null;
} {
  return { items: [], hasMore: false, nextCursor: null };
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
    listHomeMaintenance?: (input: ListHomeMaintenanceInput) => Promise<{
      items: readonly MaintenanceListItemProjection[];
      hasMore: boolean;
      nextCursor: string | null;
    }>;
    readMaintenanceEntry?: (
      input: ReadMaintenanceEntryInput,
    ) => Promise<MaintenanceDetailProjection>;
  } = {},
) {
  const createCalls: CreateMaintenanceEntryInput[] = [];
  const listCalls: ListHomeMaintenanceInput[] = [];
  const readCalls: ReadMaintenanceEntryInput[] = [];
  return {
    createCalls,
    listCalls,
    readCalls,
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
          listHomeMaintenance: async (input) => {
            listCalls.push(input);
            if (options.listHomeMaintenance) {
              return options.listHomeMaintenance(input);
            }
            return emptyPage();
          },
          readMaintenanceEntry: async (input) => {
            readCalls.push(input);
            if (options.readMaintenanceEntry) {
              return options.readMaintenanceEntry(input);
            }
            return projection({ id: input.maintenanceEntryId });
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

const listDtoKeys = [
  'id',
  'title',
  'status',
  'visibility',
  'createdByMembershipId',
  'resolvedByMembershipId',
  'resolvedAt',
  'createdAt',
  'updatedAt',
];

function getList(
  app: ReturnType<typeof buildApp>['app'],
  options: {
    homeId?: string;
    query?: string;
    origin?: string;
    cookie?: string;
  } = {},
) {
  const headers: Record<string, string> = {};
  if (options.origin !== undefined) {
    headers.Origin = options.origin;
  }
  if (options.cookie !== undefined) {
    headers.Cookie = options.cookie;
  }
  const suffix = options.query === undefined ? '' : `?${options.query}`;
  return appRequest(app, {
    method: 'GET',
    path: `${maintenancePath(options.homeId)}${suffix}`,
    headers,
  });
}

function getDetail(
  app: ReturnType<typeof buildApp>['app'],
  maintenanceEntryId: string,
  options: { homeId?: string; origin?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (options.origin !== undefined) {
    headers.Origin = options.origin;
  }
  return appRequest(app, {
    method: 'GET',
    path: `${maintenancePath(options.homeId)}/${maintenanceEntryId}`,
    headers,
  });
}

void describe('GET /api/v1/homes/:homeId/maintenance', () => {
  void it('returns 200 with the exact list page DTO and private/no-store headers', async () => {
    const { app, listCalls } = buildApp({
      listHomeMaintenance: () =>
        Promise.resolve({
          items: [
            listItem(),
            listItem({
              id: '018f1e2c-7e3a-7000-8000-1234567890ac',
              title: 'Resolved leak',
              status: 'RESOLVED',
              resolvedByMembershipId: MEMBERSHIP_ID,
              resolvedAt: CREATED,
            }),
          ],
          hasMore: true,
          nextCursor: 'opaque-cursor',
        }),
    });
    const res = await getList(app);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const body = maintenanceListPageDtoSchema.parse(res.json());
    assert.deepEqual(Object.keys(body), ['items', 'hasMore', 'nextCursor']);
    assert.equal(body.items.length, 2);
    assert.deepEqual(Object.keys(body.items[0] ?? {}), listDtoKeys);
    assert.equal('details' in (body.items[0] ?? {}), false);
    assert.equal('homeId' in (body.items[0] ?? {}), false);
    assert.equal('audienceMembershipIds' in (body.items[0] ?? {}), false);
    assert.equal(body.hasMore, true);
    assert.equal(body.nextCursor, 'opaque-cursor');
    assert.deepEqual(listCalls[0], {
      actor: actor(),
      homeId: HOME_ID,
      limit: 25,
    });
  });

  void it('returns 200 with a valid empty page', async () => {
    const { app } = buildApp({
      listHomeMaintenance: () => Promise.resolve(emptyPage()),
    });
    const res = await getList(app);
    assert.equal(res.status, 200);
    const body = maintenanceListPageDtoSchema.parse(res.json());
    assert.deepEqual(body, {
      items: [],
      hasMore: false,
      nextCursor: null,
    });
  });

  void it('does not require a mutation Origin', async () => {
    const { app, listCalls } = buildApp();
    const missing = await getList(app);
    assert.equal(missing.status, 200);
    const hostile = await getList(app, { origin: HOSTILE_ORIGIN });
    assert.equal(hostile.status, 200);
    assert.equal(listCalls.length, 2);
  });

  void it('passes status and limit through and defaults limit to 25', async () => {
    const { app, listCalls } = buildApp();
    const open = await getList(app, { query: 'status=OPEN&limit=10' });
    assert.equal(open.status, 200);
    assert.equal(listCalls[0]?.status, 'OPEN');
    assert.equal(listCalls[0]?.limit, 10);
    const resolved = await getList(app, { query: 'status=RESOLVED' });
    assert.equal(resolved.status, 200);
    assert.equal(listCalls[1]?.status, 'RESOLVED');
    assert.equal(listCalls[1]?.limit, 25);
  });

  void it('passes an opaque cursor without decoding it', async () => {
    const { app, listCalls } = buildApp();
    const res = await getList(app, { query: 'cursor=opaque-token' });
    assert.equal(res.status, 200);
    assert.equal(listCalls[0]?.cursor, 'opaque-token');
  });

  void it('rejects invalid status, limit, and empty cursor', async () => {
    const { app, listCalls } = buildApp();
    for (const query of [
      'status=CLOSED',
      'status=ALL',
      'status=PENDING',
      'status=open',
      'status=',
      'status=OPEN&status=RESOLVED',
      'limit=0',
      'limit=-1',
      'limit=101',
      'limit=1.5',
      'limit=25.0',
      'limit=abc',
      'limit=',
      'limit=01',
      'cursor=',
    ]) {
      const res = await getList(app, { query });
      assert.equal(res.status, 400);
      assert.equal((res.json() as ApiErrorBody).error.code, 'INVALID_REQUEST');
    }
    assert.deepEqual(listCalls, []);
  });

  void it('maps malformed cursor failures to 400 without exposing cursor contents', async () => {
    const { app, listCalls } = buildApp({
      listHomeMaintenance: (input) => {
        if (input.cursor === '%%%') {
          return Promise.reject(new InvalidRequestError());
        }
        return Promise.resolve(emptyPage());
      },
    });
    const res = await getList(app, {
      query: `cursor=${encodeURIComponent('%%%')}`,
    });
    assert.equal(res.status, 400);
    assert.equal((res.json() as ApiErrorBody).error.code, 'INVALID_REQUEST');
    assert.equal((res.json() as ApiErrorBody).error.message, 'Invalid request');
    assert.equal(listCalls[0]?.cursor, '%%%');
    assert.equal(res.text.includes('%%%'), false);
  });

  void it('maps stale-scope concealment to 404, distinct from a valid empty page', async () => {
    const stale = buildApp({
      listHomeMaintenance: () => Promise.reject(new ConcealedNotFoundError()),
    });
    const staleRes = await getList(stale.app);
    assert.equal(staleRes.status, 404);
    assert.equal((staleRes.json() as ApiErrorBody).error.code, 'NOT_FOUND');
    assert.equal((staleRes.json() as ApiErrorBody).error.message, 'Not found');
    assert.equal(stale.listCalls.length, 1);

    const empty = buildApp({
      listHomeMaintenance: () => Promise.resolve(emptyPage()),
    });
    const emptyRes = await getList(empty.app);
    assert.equal(emptyRes.status, 200);
    assert.deepEqual(emptyRes.json(), {
      items: [],
      hasMore: false,
      nextCursor: null,
    });
  });

  void it('returns 401 for unauthenticated list requests', async () => {
    const { app, listCalls } = buildApp({
      requirePrincipal: () => Promise.reject(new UnauthenticatedError()),
    });
    const res = await getList(app);
    assert.equal(res.status, 401);
    assert.deepEqual(listCalls, []);
  });

  void it('conceals an inaccessible Home without invoking list', async () => {
    const { app, listCalls } = buildApp({
      resolve: () => Promise.resolve(null),
    });
    const res = await getList(app, { homeId: OTHER_HOME_ID });
    assert.equal(res.status, 404);
    assert.deepEqual(listCalls, []);
  });
});

void describe('GET /api/v1/homes/:homeId/maintenance/:maintenanceEntryId', () => {
  void it('returns 200 with the exact detail DTO including details', async () => {
    const { app, readCalls } = buildApp({
      readMaintenanceEntry: () =>
        Promise.resolve(projection({ details: 'Kitchen sink' })),
    });
    const res = await getDetail(app, ENTRY_ID);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const body = maintenanceDetailDtoSchema.parse(res.json());
    assert.deepEqual(Object.keys(body), dtoKeys);
    assert.equal(body.details, 'Kitchen sink');
    assert.equal('homeId' in (res.json() as object), false);
    assert.equal('audienceMembershipIds' in (res.json() as object), false);
    assert.deepEqual(readCalls[0], {
      actor: actor(),
      homeId: HOME_ID,
      maintenanceEntryId: ENTRY_ID,
    });
  });

  void it('does not require a mutation Origin', async () => {
    const { app, readCalls } = buildApp();
    const missing = await getDetail(app, ENTRY_ID);
    assert.equal(missing.status, 200);
    const hostile = await getDetail(app, ENTRY_ID, { origin: HOSTILE_ORIGIN });
    assert.equal(hostile.status, 200);
    assert.equal(readCalls.length, 2);
  });

  void it('rejects malformed IDs before invoking read', async () => {
    const { app, readCalls } = buildApp();
    const res = await getDetail(app, 'not-a-uuid');
    assert.equal(res.status, 400);
    assert.equal((res.json() as ApiErrorBody).error.code, 'INVALID_PATH_INPUT');
    assert.deepEqual(readCalls, []);
  });

  void it('maps concealed unknown, foreign, invisible, archived, and stale reads to the same 404', async () => {
    const shapes: Array<{ code: string; message: string }> = [];
    for (let index = 0; index < 5; index += 1) {
      const { app } = buildApp({
        readMaintenanceEntry: () =>
          Promise.reject(new ConcealedNotFoundError()),
      });
      const res = await getDetail(app, ENTRY_ID);
      assert.equal(res.status, 404);
      const error = (res.json() as ApiErrorBody).error;
      assert.equal(error.code, 'NOT_FOUND');
      assert.equal(error.message, 'Not found');
      shapes.push({ code: error.code, message: error.message });
      assertNoForbiddenLeak({
        context: 'concealed maintenance read HTTP',
        text: res.text,
        forbidden: [...leakSentinels, ENTRY_ID, 'PRIVATE', 'visibility'],
      });
    }
    assert.deepEqual(shapes[0], shapes[1]);
    assert.deepEqual(shapes[1], shapes[2]);
    assert.deepEqual(shapes[2], shapes[3]);
    assert.deepEqual(shapes[3], shapes[4]);
  });

  void it('returns 401 for unauthenticated detail requests', async () => {
    const { app, readCalls } = buildApp({
      requirePrincipal: () => Promise.reject(new UnauthenticatedError()),
    });
    const res = await getDetail(app, ENTRY_ID);
    assert.equal(res.status, 401);
    assert.deepEqual(readCalls, []);
  });
});
