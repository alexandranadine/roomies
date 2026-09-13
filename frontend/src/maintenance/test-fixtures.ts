import type {
  MaintenanceDetail,
  MaintenanceListItem,
  MaintenanceListPage,
} from './maintenance-api.js';

export const TEST_HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const TEST_HOME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
export const TEST_MEMBERSHIP_A = 'm1111111-1111-4111-8111-111111111111';
export const TEST_MEMBERSHIP_B = 'm2222222-2222-4222-8222-222222222222';

const BASE_TIMES = {
  createdAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-10T15:30:00.000Z',
} as const;

/** H — HOUSEHOLD OPEN */
export const FIXTURE_H: MaintenanceListItem = {
  id: 'h1111111-1111-4111-8111-111111111111',
  title: 'Replace furnace filter',
  status: 'OPEN',
  visibility: 'HOUSEHOLD',
  createdByMembershipId: TEST_MEMBERSHIP_A,
  resolvedByMembershipId: null,
  resolvedAt: null,
  ...BASE_TIMES,
  updatedAt: '2026-09-12T10:00:00.000Z',
};

/** A — PRIVATE OPEN visible to current test actor */
export const FIXTURE_A: MaintenanceListItem = {
  id: 'a1111111-1111-4111-8111-111111111111',
  title: 'Quiet leak under sink',
  status: 'OPEN',
  visibility: 'PRIVATE',
  createdByMembershipId: TEST_MEMBERSHIP_A,
  resolvedByMembershipId: null,
  resolvedAt: null,
  ...BASE_TIMES,
  updatedAt: '2026-09-11T09:00:00.000Z',
};

/**
 * B — invisible PRIVATE. Must NEVER appear in authorized fixtures.
 * Used only to assert the client does not invent it.
 */
export const FIXTURE_B_ID = 'b1111111-1111-4111-8111-111111111111';
export const FIXTURE_B_TITLE = 'Invisible private item B';

/** R — RESOLVED visible entry */
export const FIXTURE_R: MaintenanceListItem = {
  id: 'r1111111-1111-4111-8111-111111111111',
  title: 'Fixed hallway light',
  status: 'RESOLVED',
  visibility: 'HOUSEHOLD',
  createdByMembershipId: TEST_MEMBERSHIP_A,
  resolvedByMembershipId: TEST_MEMBERSHIP_B,
  resolvedAt: '2026-09-09T18:00:00.000Z',
  createdAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-09T18:00:00.000Z',
};

export function listPage(
  items: readonly MaintenanceListItem[],
  options: { hasMore?: boolean; nextCursor?: string | null } = {},
): MaintenanceListPage {
  return {
    items: [...items],
    hasMore: options.hasMore ?? false,
    nextCursor: options.nextCursor ?? null,
  };
}

export function detailFromListItem(
  item: MaintenanceListItem,
  details: string | null,
): MaintenanceDetail {
  return {
    ...item,
    details,
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
