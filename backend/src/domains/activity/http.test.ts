import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ListHomeActivityInput } from '../../application/activity/list-home-activity.js';
import { createRoomiesApiRouter } from '../../http/create-roomies-api.js';
import { UnauthenticatedError } from '../../platform/auth/errors.js';
import type { PrincipalResolver } from '../../platform/auth/principal.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  InvalidRequestError,
} from '../../platform/authz/errors.js';
import { appRequest } from '../../platform/http/app-request.test-helper.js';
import { createApp } from '../../platform/http/create-app.js';
import type { ApiErrorBody } from '../../platform/http/errors.js';
import type {
  ActivityListItem,
  ActivityListPage,
} from './activity-list-item.js';
import { activityListPageDtoSchema } from './activity-dto.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBERSHIP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ENTRY_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const TRUSTED_ORIGIN = 'http://localhost:5173';
const HOSTILE_ORIGIN = 'https://evil.example';
const OCCURRED = new Date('2026-09-13T18:00:00.000Z');

function actor(role: ActiveHomeActor['role'] = 'ROOMMATE'): ActiveHomeActor {
  return {
    userId: USER_ID,
    membershipId: MEMBERSHIP_ID,
    homeId: HOME_ID,
    role,
  };
}

function listItem(overrides: Partial<ActivityListItem> = {}): ActivityListItem {
  return {
    id: ENTRY_ID,
    eventType: 'task.completed.v1',
    sourceEntityType: 'TASK',
    sourceEntityId: ENTRY_ID,
    occurredAt: OCCURRED,
    actor: { membershipId: MEMBERSHIP_ID, name: 'Alex' },
    sourceTitle: 'Take out trash',
    subject: null,
    ...overrides,
  };
}

function emptyPage(): ActivityListPage {
  return { items: [], hasMore: false, nextCursor: null };
}

function unusedHomeReader() {
  return {
    findActiveHomeById: () =>
      Promise.reject(new Error('home reader must not run for activity')),
  };
}

function buildApp(
  options: {
    requirePrincipal?: PrincipalResolver['requirePrincipal'];
    resolve?: (input: {
      userId: string;
      homeId: string;
    }) => Promise<ActiveHomeActor | null>;
    listHomeActivity?: (
      input: ListHomeActivityInput,
    ) => Promise<ActivityListPage>;
  } = {},
) {
  const listCalls: ListHomeActivityInput[] = [];
  return {
    listCalls,
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
          Promise.reject(new Error('archive must not run for activity')),
        changeMembershipRole: () =>
          Promise.reject(new Error('role change must not run for activity')),
        leaveMembership: () =>
          Promise.reject(new Error('leave must not run for activity')),
        removeMembership: () =>
          Promise.reject(new Error('remove must not run for activity')),
        activity: {
          listHomeActivity: async (input) => {
            listCalls.push(input);
            if (options.listHomeActivity) {
              return options.listHomeActivity(input);
            }
            return emptyPage();
          },
        },
      }),
    }),
  };
}

function activityPath(homeId = HOME_ID, query?: string): string {
  return `/api/v1/homes/${homeId}/activity${query === undefined ? '' : `?${query}`}`;
}

async function getList(
  app: ReturnType<typeof createApp>,
  options: {
    homeId?: string;
    query?: string;
    origin?: string | null;
    cookie?: string;
  } = {},
) {
  const headers: Record<string, string> = {};
  if (options.origin !== null) {
    headers.Origin = options.origin ?? TRUSTED_ORIGIN;
  }
  if (options.cookie !== undefined) {
    headers.Cookie = options.cookie;
  }
  return appRequest(app, {
    method: 'GET',
    path: activityPath(options.homeId, options.query),
    headers,
  });
}

void describe('GET /api/v1/homes/:homeId/activity', () => {
  void it('returns 200 with the exact list page DTO and private/no-store headers', async () => {
    const { app, listCalls } = buildApp({
      listHomeActivity: () =>
        Promise.resolve({
          items: [
            listItem(),
            listItem({
              id: '018f1e2c-7e3a-7000-8000-1234567890ac',
              eventType: 'supply.obtained.v1',
              sourceEntityType: 'SUPPLY',
              sourceTitle: 'Milk',
            }),
          ],
          hasMore: true,
          nextCursor: 'opaque-cursor',
        }),
    });
    const res = await getList(app);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const body = activityListPageDtoSchema.parse(res.json());
    assert.deepEqual(Object.keys(body), ['items', 'hasMore', 'nextCursor']);
    assert.equal(body.items.length, 2);
    assert.deepEqual(Object.keys(body.items[0] ?? {}), [
      'id',
      'eventType',
      'sourceEntityType',
      'sourceEntityId',
      'occurredAt',
      'actor',
      'sourceTitle',
      'subject',
    ]);
    assert.equal('details' in (body.items[0] ?? {}), false);
    assert.equal('homeId' in (body.items[0] ?? {}), false);
    assert.equal('userId' in (body.items[0] ?? {}), false);
    assert.equal('audienceMembershipIds' in (body.items[0] ?? {}), false);
    assert.equal('visibilityClass' in (body.items[0] ?? {}), false);
    assert.equal('recipients' in (body.items[0] ?? {}), false);
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
      listHomeActivity: () => Promise.resolve(emptyPage()),
    });
    const res = await getList(app);
    assert.equal(res.status, 200);
    const body = activityListPageDtoSchema.parse(res.json());
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

  void it('passes limit through and defaults limit to 25', async () => {
    const { app, listCalls } = buildApp();
    const limited = await getList(app, { query: 'limit=10' });
    assert.equal(limited.status, 200);
    assert.equal(listCalls[0]?.limit, 10);
    const def = await getList(app);
    assert.equal(def.status, 200);
    assert.equal(listCalls[1]?.limit, 25);
  });

  void it('passes an opaque cursor without decoding it', async () => {
    const { app, listCalls } = buildApp();
    const res = await getList(app, { query: 'cursor=opaque-token' });
    assert.equal(res.status, 200);
    assert.equal(listCalls[0]?.cursor, 'opaque-token');
  });

  void it('rejects invalid limit and empty cursor', async () => {
    const { app, listCalls } = buildApp();
    for (const query of [
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
      listHomeActivity: (input) => {
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
      listHomeActivity: () => Promise.reject(new ConcealedNotFoundError()),
    });
    const staleRes = await getList(stale.app);
    assert.equal(staleRes.status, 404);
    assert.equal((staleRes.json() as ApiErrorBody).error.code, 'NOT_FOUND');
    assert.equal((staleRes.json() as ApiErrorBody).error.message, 'Not found');
    assert.equal(staleRes.headers.get('cache-control'), 'private, no-store');
    assert.equal(stale.listCalls.length, 1);

    const empty = buildApp({
      listHomeActivity: () => Promise.resolve(emptyPage()),
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
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(listCalls, []);
  });

  void it('conceals an inaccessible Home without invoking list', async () => {
    const { app, listCalls } = buildApp({
      resolve: () => Promise.resolve(null),
    });
    const res = await getList(app, { homeId: OTHER_HOME_ID });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(listCalls, []);
  });
});
