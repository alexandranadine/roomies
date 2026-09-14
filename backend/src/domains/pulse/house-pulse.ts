import type { DateString } from '../tasks/home-local-date.js';

export const HOUSE_PULSE_SECTION_STATES = ['CLEAR', 'ACTIVE'] as const;
export const HOUSE_PULSE_ITEM_TYPES = [
  'TASKS',
  'SUPPLIES',
  'MAINTENANCE',
] as const;

export type HousePulseSectionState =
  (typeof HOUSE_PULSE_SECTION_STATES)[number];
export type HousePulseItemType = (typeof HOUSE_PULSE_ITEM_TYPES)[number];

export type TaskPulseItem = Readonly<{
  type: 'TASKS';
  state: HousePulseSectionState;
  assignedOpenCount: number;
  unassignedOpenCount: number;
  dueTodayRelevantCount: number;
  overdueRelevantCount: number;
}>;

export type SupplyPulseItem = Readonly<{
  type: 'SUPPLIES';
  state: HousePulseSectionState;
  openCount: number;
  unclaimedOpenCount: number;
  claimedByMeCount: number;
}>;

export type MaintenancePulseItem = Readonly<{
  type: 'MAINTENANCE';
  state: HousePulseSectionState;
  openVisibleCount: number;
}>;

export type HousePulse = Readonly<{
  generatedAt: Date;
  homeLocalDate: DateString;
  items: readonly [TaskPulseItem, SupplyPulseItem, MaintenancePulseItem];
}>;

export function housePulseSectionState(
  ...counts: readonly number[]
): HousePulseSectionState {
  return counts.some((count) => count > 0) ? 'ACTIVE' : 'CLEAR';
}
