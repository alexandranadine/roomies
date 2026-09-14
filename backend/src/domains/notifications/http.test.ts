import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ListCurrentUserNotificationsInput } from '../../application/notifications/list-current-user-notifications.js';
import type { MarkNotificationReadInput } from '../../application/notifications/mark-notification-read.js';
import type { ReadAllNotificationsInput } from '../../application/notifications/read-all-notifications.js';
import { createRoomiesApiRouter } from '../../http/create-roomies-api.js';
import { UnauthenticatedError } from '../../platform/auth/errors.js';
import type { PrincipalResolver } from '../../platform/auth/principal.js';
import {
  ConcealedNotFoundError,
  InvalidRequestError,
} from '../../platform/authz/errors.js';
import { appRequest } from '../../platform/http/app-request.test-helper.js';
import { createApp } from '../../platform/http/create-app.js';
import type { ApiErrorBody } from '../../platform/http/errors.js';
import type {
  NotificationListItem,
  NotificationListPage,
} from './notification-list-item.js';
import { notificationListPageDtoSchema } from './notification-dto.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ENTRY_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const TRUSTED_ORIGIN = 'http://localhost:5173';
const HOSTILE_ORIGIN = 'https://evil.example';
const OCCURRED = new Date('2026-09-13T18:00:00.000Z');

function listItem(
  overrides: Partial<NotificationListItem> = {},
): NotificationListItem {
  return {
    id: ENTRY_ID,
    kind: 'ASSIGNED_TASK_COMPLETED',
    occurredAt: OCCURRED,
    readAt: null,
    home: { id: HOME_ID, name: 'Home A' },
    actor: { name: 'Alex' },
    source: { type: 'TASK', title: 'Take out trash' },
    destination: {
      type: 'TASK',
      homeId: HOME_ID,
      taskInstanceId: ENTRY_ID,
    },
    ...overrides,
  };
}

function emptyPage(): NotificationListPage {
  return { items: [], hasMore: false, nextCursor: null };
}

function unusedHomeReader() {
  return {
    findActiveHomeById: () =>
      Promise.reject(new Error('home reader must not run for notifications')),
  };
}

function buildApp(
  options: {
    requirePrincipal?: PrincipalResolver['requirePrincipal'];
    listCurrentUserNotifications?: (
      input: ListCurrentUserNotificationsInput,
    ) => Promise<NotificationListPage>;
    markNotificationRead?: (input: MarkNotificationReadInput) => Promise<void>;
    readAllNotifications?: (input: ReadAllNotificationsInput) => Promise<void>;
  } = {},
) {
  const listCalls: ListCurrentUserNotificationsInput[] = [];
  const markCalls: MarkNotificationReadInput[] = [];
  const readAllCalls: ReadAllNotificationsInput[] = [];
  return {
    listCalls,
    markCalls,
    readAllCalls,
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
          resolve: () =>
            Promise.reject(
              new Error('home actor must not run for notifications'),
            ),
        },
        homeReader: unusedHomeReader(),
        archiveFinalMemberHome: () =>
          Promise.reject(new Error('archive must not run')),
        changeMembershipRole: () =>
          Promise.reject(new Error('role change must not run')),
        leaveMembership: () => Promise.reject(new Error('leave must not run')),
        removeMembership: () =>
          Promise.reject(new Error('remove must not run')),
        notifications: {
          listCurrentUserNotifications: async (input) => {
            listCalls.push(input);
            if (options.listCurrentUserNotifications) {
              return options.listCurrentUserNotifications(input);
            }
            return emptyPage();
          },
          markNotificationRead: async (input) => {
            markCalls.push(input);
            if (options.markNotificationRead) {
              return options.markNotificationRead(input);
            }
          },
          readAllNotifications: async (input) => {
            readAllCalls.push(input);
            if (options.readAllNotifications) {
              return options.readAllNotifications(input);
            }
          },
        },
      }),
    }),
  };
}

async function getList(
  app: ReturnType<typeof createApp>,
  options: { query?: string; origin?: string | null } = {},
) {
  const headers: Record<string, string> = {};
  if (options.origin !== null) {
    headers.Origin = options.origin ?? TRUSTED_ORIGIN;
  }
  return appRequest(app, {
    method: 'GET',
    path: `/api/v1/notifications${options.query === undefined ? '' : `?${options.query}`}`,
    headers,
  });
}

async function postRead(
  app: ReturnType<typeof createApp>,
  options: {
    path: string;
    origin?: string | null;
    body?: string;
  },
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (options.origin !== null) {
    headers.Origin = options.origin ?? TRUSTED_ORIGIN;
  }
  return appRequest(app, {
    method: 'POST',
    path: options.path,
    headers,
    body: options.body ?? '{}',
  });
}

void describe('GET /api/v1/notifications', () => {
  void it('returns 200 with the exact list page DTO and private/no-store headers', async () => {
    const { app, listCalls } = buildApp({
      listCurrentUserNotifications: () =>
        Promise.resolve({
          items: [
            listItem(),
            listItem({
              id: '018f1e2c-7e3a-7000-8000-1234567890ac',
              kind: 'CREATED_SUPPLY_OBTAINED',
              source: { type: 'SUPPLY', title: 'Milk' },
              destination: {
                type: 'SUPPLY',
                homeId: HOME_ID,
                supplyEntryId: '018f1e2c-7e3a-7000-8000-1234567890ac',
              },
            }),
          ],
          hasMore: true,
          nextCursor: 'opaque-cursor',
        }),
    });
    const res = await getList(app);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const body = notificationListPageDtoSchema.parse(res.json());
    assert.deepEqual(Object.keys(body), ['items', 'hasMore', 'nextCursor']);
    assert.equal(body.items.length, 2);
    assert.deepEqual(Object.keys(body.items[0] ?? {}), [
      'id',
      'kind',
      'occurredAt',
      'readAt',
      'home',
      'actor',
      'source',
      'destination',
    ]);
    assert.equal('details' in (body.items[0] ?? {}), false);
    assert.equal('userId' in (body.items[0] ?? {}), false);
    assert.equal('recipientMembershipId' in (body.items[0] ?? {}), false);
    assert.equal('unreadCount' in body, false);
    assert.equal(body.hasMore, true);
    assert.equal(body.nextCursor, 'opaque-cursor');
    assert.deepEqual(listCalls[0], { userId: USER_ID, limit: 25 });
  });

  void it('returns 200 with a valid empty page', async () => {
    const { app } = buildApp();
    const res = await getList(app);
    assert.equal(res.status, 200);
    assert.deepEqual(notificationListPageDtoSchema.parse(res.json()), {
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
      listCurrentUserNotifications: (input) => {
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

  void it('returns 401 for unauthenticated list requests', async () => {
    const { app, listCalls } = buildApp({
      requirePrincipal: () => Promise.reject(new UnauthenticatedError()),
    });
    const res = await getList(app);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(listCalls, []);
  });
});

void describe('POST /api/v1/notifications/:notificationId/read', () => {
  void it('returns 204 for an eligible mark-one without a count', async () => {
    const { app, markCalls } = buildApp();
    const res = await postRead(app, {
      path: `/api/v1/notifications/${ENTRY_ID}/read`,
    });
    assert.equal(res.status, 204);
    assert.equal(res.text, '');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(markCalls, [
      { userId: USER_ID, notificationId: ENTRY_ID },
    ]);
  });

  void it('maps invisible notifications to a concealed 404', async () => {
    const { app } = buildApp({
      markNotificationRead: () => Promise.reject(new ConcealedNotFoundError()),
    });
    const res = await postRead(app, {
      path: `/api/v1/notifications/${ENTRY_ID}/read`,
    });
    assert.equal(res.status, 404);
    assert.equal((res.json() as ApiErrorBody).error.code, 'NOT_FOUND');
    assert.equal((res.json() as ApiErrorBody).error.message, 'Not found');
    assert.equal(res.text.includes(OTHER_USER), false);
    assert.equal(res.text.includes('audience'), false);
  });

  void it('returns 401 for unauthenticated mark-one requests', async () => {
    const { app, markCalls } = buildApp({
      requirePrincipal: () => Promise.reject(new UnauthenticatedError()),
    });
    const res = await postRead(app, {
      path: `/api/v1/notifications/${ENTRY_ID}/read`,
    });
    assert.equal(res.status, 401);
    assert.deepEqual(markCalls, []);
  });

  void it('rejects a hostile Origin before marking', async () => {
    const { app, markCalls } = buildApp();
    const res = await postRead(app, {
      path: `/api/v1/notifications/${ENTRY_ID}/read`,
      origin: HOSTILE_ORIGIN,
    });
    assert.equal(res.status, 403);
    assert.deepEqual(markCalls, []);
  });
});

void describe('POST /api/v1/notifications/read-all', () => {
  void it('returns 204 without an affected-row count', async () => {
    const { app, readAllCalls } = buildApp();
    const res = await postRead(app, { path: '/api/v1/notifications/read-all' });
    assert.equal(res.status, 204);
    assert.equal(res.text, '');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(readAllCalls, [{ userId: USER_ID }]);
  });

  void it('returns 204 when the command finds zero eligible rows', async () => {
    const { app } = buildApp({
      readAllNotifications: () => Promise.resolve(),
    });
    const res = await postRead(app, { path: '/api/v1/notifications/read-all' });
    assert.equal(res.status, 204);
    assert.equal(res.text.includes('0'), false);
    assert.equal(res.text.includes('count'), false);
  });

  void it('returns 401 for unauthenticated read-all requests', async () => {
    const { app, readAllCalls } = buildApp({
      requirePrincipal: () => Promise.reject(new UnauthenticatedError()),
    });
    const res = await postRead(app, { path: '/api/v1/notifications/read-all' });
    assert.equal(res.status, 401);
    assert.deepEqual(readAllCalls, []);
  });
});
