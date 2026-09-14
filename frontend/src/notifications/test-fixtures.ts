import type {
  NotificationListItem,
  NotificationListPage,
} from './notifications-api.js';
import { NOTIFICATION_KINDS } from './notification-copy.js';

export const TEST_HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const TEST_HOME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
export const TEST_TASK_ID = 't1111111-1111-4111-8111-111111111111';
export const TEST_SUPPLY_ID = 's1111111-1111-4111-8111-111111111111';
export const TEST_MAINTENANCE_ID = 'n1111111-1111-4111-8111-111111111111';

const OCCURRED = '2026-09-13T18:00:00.000Z';

export function notificationItem(
  overrides: Partial<NotificationListItem> = {},
): NotificationListItem {
  return {
    id: 'n1111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    kind: NOTIFICATION_KINDS.ASSIGNED_TASK_COMPLETED,
    occurredAt: OCCURRED,
    readAt: null,
    home: { id: TEST_HOME_A, name: 'Oak Street' },
    actor: { name: 'Alex' },
    source: { type: 'TASK', title: 'Take out trash' },
    destination: {
      type: 'TASK',
      homeId: TEST_HOME_A,
      taskInstanceId: TEST_TASK_ID,
    },
    ...overrides,
  };
}

export const FIXTURE_ROLE_CHANGED = notificationItem({
  id: 'n1111111-1111-4111-8111-111111111111',
  kind: NOTIFICATION_KINDS.MEMBERSHIP_ROLE_CHANGED,
  actor: null,
  source: null,
  destination: { type: 'ROOMMATES', homeId: TEST_HOME_A },
  occurredAt: '2026-09-13T18:00:00.000Z',
});

export const FIXTURE_TASK_TITLED = notificationItem({
  id: 'n2222222-2222-4222-8222-222222222222',
  kind: NOTIFICATION_KINDS.ASSIGNED_TASK_COMPLETED,
  occurredAt: '2026-09-13T17:00:00.000Z',
});

export const FIXTURE_TASK_GENERIC = notificationItem({
  id: 'n3333333-3333-4333-8333-333333333333',
  kind: NOTIFICATION_KINDS.ASSIGNED_TASK_COMPLETED,
  source: null,
  actor: null,
  occurredAt: '2026-09-13T16:30:00.000Z',
});

export const FIXTURE_SUPPLY_TITLED = notificationItem({
  id: 'n4444444-4444-4444-8444-444444444444',
  kind: NOTIFICATION_KINDS.CREATED_SUPPLY_OBTAINED,
  source: { type: 'SUPPLY', title: 'Paper towels' },
  destination: {
    type: 'SUPPLY',
    homeId: TEST_HOME_A,
    supplyEntryId: TEST_SUPPLY_ID,
  },
  occurredAt: '2026-09-13T16:00:00.000Z',
});

export const FIXTURE_SUPPLY_GENERIC = notificationItem({
  id: 'n5555555-5555-4555-8555-555555555555',
  kind: NOTIFICATION_KINDS.CREATED_SUPPLY_OBTAINED,
  actor: null,
  source: null,
  destination: {
    type: 'SUPPLY',
    homeId: TEST_HOME_A,
    supplyEntryId: TEST_SUPPLY_ID,
  },
  occurredAt: '2026-09-13T15:30:00.000Z',
});

export const FIXTURE_PRIVATE_CREATED = notificationItem({
  id: 'n6666666-6666-4666-8666-666666666666',
  kind: NOTIFICATION_KINDS.PRIVATE_MAINTENANCE_CREATED,
  actor: null,
  source: null,
  destination: { type: 'HOME', homeId: TEST_HOME_A },
  occurredAt: '2026-09-13T15:00:00.000Z',
});

export const FIXTURE_PRIVATE_RESOLVED = notificationItem({
  id: 'n7777777-7777-4777-8777-777777777777',
  kind: NOTIFICATION_KINDS.PRIVATE_MAINTENANCE_RESOLVED,
  actor: null,
  source: null,
  destination: { type: 'HOME', homeId: TEST_HOME_A },
  occurredAt: '2026-09-13T14:00:00.000Z',
});

export const FIXTURE_HOME_B_TASK = notificationItem({
  id: 'n8888888-8888-4888-8888-888888888888',
  kind: NOTIFICATION_KINDS.ASSIGNED_TASK_COMPLETED,
  home: { id: TEST_HOME_B, name: 'Cedar House' },
  actor: { name: 'Casey' },
  source: { type: 'TASK', title: 'Water the plants' },
  destination: {
    type: 'TASK',
    homeId: TEST_HOME_B,
    taskInstanceId: 't2222222-2222-4222-8222-222222222222',
  },
  occurredAt: '2026-09-13T13:00:00.000Z',
  readAt: '2026-09-13T13:05:00.000Z',
});

export const FIXTURE_READ_TASK = notificationItem({
  id: 'n9999999-9999-4999-8999-999999999999',
  kind: NOTIFICATION_KINDS.ASSIGNED_TASK_COMPLETED,
  readAt: '2026-09-13T17:05:00.000Z',
  occurredAt: '2026-09-13T17:00:00.000Z',
});

export function listPage(
  items: NotificationListItem[],
  overrides: Partial<NotificationListPage> = {},
): NotificationListPage {
  return {
    items,
    hasMore: false,
    nextCursor: null,
    ...overrides,
  };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

export function notFoundBody() {
  return {
    error: { code: 'NOT_FOUND', message: 'Not found' },
  };
}

export function unauthenticatedBody() {
  return {
    error: {
      code: 'UNAUTHENTICATED',
      message: 'Authentication required',
    },
  };
}
