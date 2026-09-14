import type { ActivityListItem, ActivityListPage } from './activity-api.js';
import { ACTIVITY_EVENT_TYPES } from './activity-copy.js';

export const TEST_HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const TEST_HOME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
export const TEST_MEMBERSHIP_ALEX = 'm1111111-1111-4111-8111-111111111111';
export const TEST_MEMBERSHIP_JAMIE = 'm2222222-2222-4222-8222-222222222222';
export const TEST_MEMBERSHIP_TAYLOR = 'm3333333-3333-4333-8333-333333333333';

export const SOURCE_TASK_ID = 't1111111-1111-4111-8111-111111111111';
export const SOURCE_SUPPLY_ID = 's1111111-1111-4111-8111-111111111111';
export const SOURCE_MAINTENANCE_ID = 'n1111111-1111-4111-8111-111111111111';
export const SOURCE_MEMBERSHIP_JAMIE = TEST_MEMBERSHIP_JAMIE;

const OCCURRED = '2026-09-13T18:00:00.000Z';

export function activityItem(
  overrides: Partial<ActivityListItem> = {},
): ActivityListItem {
  return {
    id: 'a1111111-1111-4111-8111-111111111111',
    eventType: ACTIVITY_EVENT_TYPES.TASK_COMPLETED,
    sourceEntityType: 'TASK',
    sourceEntityId: SOURCE_TASK_ID,
    occurredAt: OCCURRED,
    actor: { membershipId: TEST_MEMBERSHIP_ALEX, name: 'Alex' },
    sourceTitle: 'Take out trash',
    subject: null,
    ...overrides,
  };
}

export const FIXTURE_TASK_TITLED = activityItem();

export const FIXTURE_TASK_GENERIC = activityItem({
  id: 'a2222222-2222-4222-8222-222222222222',
  sourceTitle: null,
});

export const FIXTURE_SUPPLY_TITLED = activityItem({
  id: 'a3333333-3333-4333-8333-333333333333',
  eventType: ACTIVITY_EVENT_TYPES.SUPPLY_OBTAINED,
  sourceEntityType: 'SUPPLY',
  sourceEntityId: SOURCE_SUPPLY_ID,
  sourceTitle: 'Paper towels',
  occurredAt: '2026-09-13T17:00:00.000Z',
});

export const FIXTURE_SUPPLY_GENERIC = activityItem({
  id: 'a4444444-4444-4444-8444-444444444444',
  eventType: ACTIVITY_EVENT_TYPES.SUPPLY_OBTAINED,
  sourceEntityType: 'SUPPLY',
  sourceEntityId: SOURCE_SUPPLY_ID,
  sourceTitle: null,
});

export const FIXTURE_MAINTENANCE_CREATED = activityItem({
  id: 'a5555555-5555-4555-8555-555555555555',
  eventType: ACTIVITY_EVENT_TYPES.MAINTENANCE_CREATED,
  sourceEntityType: 'MAINTENANCE',
  sourceEntityId: SOURCE_MAINTENANCE_ID,
  sourceTitle: 'Quiet leak under sink',
  occurredAt: '2026-09-13T16:00:00.000Z',
});

export const FIXTURE_MAINTENANCE_RESOLVED = activityItem({
  id: 'a6666666-6666-4666-8666-666666666666',
  eventType: ACTIVITY_EVENT_TYPES.MAINTENANCE_RESOLVED,
  sourceEntityType: 'MAINTENANCE',
  sourceEntityId: SOURCE_MAINTENANCE_ID,
  sourceTitle: 'Quiet leak under sink',
  occurredAt: '2026-09-13T15:00:00.000Z',
});

export const FIXTURE_JOINED = activityItem({
  id: 'a7777777-7777-4777-8777-777777777777',
  eventType: ACTIVITY_EVENT_TYPES.MEMBERSHIP_STARTED,
  sourceEntityType: 'MEMBERSHIP',
  sourceEntityId: SOURCE_MEMBERSHIP_JAMIE,
  actor: { membershipId: TEST_MEMBERSHIP_JAMIE, name: 'Jamie' },
  subject: { membershipId: TEST_MEMBERSHIP_JAMIE, name: 'Jamie' },
  sourceTitle: null,
  occurredAt: '2026-09-13T14:00:00.000Z',
});

export const FIXTURE_LEFT = activityItem({
  id: 'a8888888-8888-4888-8888-888888888888',
  eventType: ACTIVITY_EVENT_TYPES.MEMBERSHIP_ENDED,
  sourceEntityType: 'MEMBERSHIP',
  sourceEntityId: SOURCE_MEMBERSHIP_JAMIE,
  actor: { membershipId: TEST_MEMBERSHIP_TAYLOR, name: 'Taylor' },
  subject: { membershipId: TEST_MEMBERSHIP_JAMIE, name: 'Jamie' },
  sourceTitle: null,
  occurredAt: '2026-09-13T13:00:00.000Z',
});

export const FIXTURE_ROLE_CHANGED = activityItem({
  id: 'a9999999-9999-4999-8999-999999999999',
  eventType: ACTIVITY_EVENT_TYPES.MEMBERSHIP_ROLE_CHANGED,
  sourceEntityType: 'MEMBERSHIP',
  sourceEntityId: SOURCE_MEMBERSHIP_JAMIE,
  actor: { membershipId: TEST_MEMBERSHIP_TAYLOR, name: 'Taylor' },
  subject: { membershipId: TEST_MEMBERSHIP_JAMIE, name: 'Jamie' },
  sourceTitle: null,
  occurredAt: '2026-09-13T12:00:00.000Z',
});

export const FIXTURE_HOME_B_TASK = activityItem({
  id: 'b1111111-1111-4111-8111-111111111111',
  sourceTitle: 'Water the plants',
  actor: { membershipId: TEST_MEMBERSHIP_TAYLOR, name: 'Casey' },
  occurredAt: '2026-09-12T18:00:00.000Z',
});

export function listPage(
  items: readonly ActivityListItem[],
  options: { hasMore?: boolean; nextCursor?: string | null } = {},
): ActivityListPage {
  return {
    items: [...items],
    hasMore: options.hasMore ?? false,
    nextCursor: options.nextCursor ?? null,
  };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function notFoundBody() {
  return { error: { code: 'NOT_FOUND', message: 'Not found' } };
}

export function unauthenticatedBody() {
  return {
    error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
  };
}
