import type {
  HousePulseDto,
  MaintenancePulseItem,
  SupplyPulseItem,
  TaskPulseItem,
} from './pulse-api.js';

export const TEST_HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const TEST_HOME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';

const GENERATED_AT = '2026-09-14T04:00:00.000Z';
const HOME_LOCAL_DATE = '2026-09-14';

export function clearTasksItem(
  overrides: Partial<TaskPulseItem> = {},
): TaskPulseItem {
  return {
    type: 'TASKS',
    state: 'CLEAR',
    assignedOpenCount: 0,
    unassignedOpenCount: 0,
    dueTodayRelevantCount: 0,
    overdueRelevantCount: 0,
    ...overrides,
  };
}

export function clearSuppliesItem(
  overrides: Partial<SupplyPulseItem> = {},
): SupplyPulseItem {
  return {
    type: 'SUPPLIES',
    state: 'CLEAR',
    openCount: 0,
    unclaimedOpenCount: 0,
    claimedByMeCount: 0,
    ...overrides,
  };
}

export function clearMaintenanceItem(
  overrides: Partial<MaintenancePulseItem> = {},
): MaintenancePulseItem {
  return {
    type: 'MAINTENANCE',
    state: 'CLEAR',
    openVisibleCount: 0,
    ...overrides,
  };
}

/** Default CLEAR Pulse used by stubs when overview loads. */
export function clearHousePulse(
  overrides: Partial<HousePulseDto> = {},
): HousePulseDto {
  return {
    generatedAt: GENERATED_AT,
    homeLocalDate: HOME_LOCAL_DATE,
    items: [clearTasksItem(), clearSuppliesItem(), clearMaintenanceItem()],
    ...overrides,
  };
}

export function activeHousePulse(): HousePulseDto {
  return {
    generatedAt: GENERATED_AT,
    homeLocalDate: HOME_LOCAL_DATE,
    items: [
      clearTasksItem({
        state: 'ACTIVE',
        assignedOpenCount: 2,
        unassignedOpenCount: 1,
        dueTodayRelevantCount: 1,
        overdueRelevantCount: 3,
      }),
      clearSuppliesItem({
        state: 'ACTIVE',
        openCount: 4,
        unclaimedOpenCount: 2,
        claimedByMeCount: 1,
      }),
      clearMaintenanceItem({
        state: 'ACTIVE',
        openVisibleCount: 2,
      }),
    ],
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
