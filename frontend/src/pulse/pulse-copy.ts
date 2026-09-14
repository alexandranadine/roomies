import type {
  HousePulseSectionState,
  MaintenancePulseItem,
  SupplyPulseItem,
  TaskPulseItem,
} from './pulse-api.js';

export function pulseStateLabel(state: HousePulseSectionState): string {
  return state === 'CLEAR' ? 'Clear' : 'Active';
}

export function tasksClearCopy(): string {
  return 'Nothing needs attention.';
}

export type PulseMetric = Readonly<{
  label: string;
  value: number;
}>;

export function tasksActiveMetrics(
  item: TaskPulseItem,
): readonly PulseMetric[] {
  return [
    { label: 'Assigned to you', value: item.assignedOpenCount },
    { label: 'Unassigned', value: item.unassignedOpenCount },
    { label: 'Due today', value: item.dueTodayRelevantCount },
    { label: 'Overdue', value: item.overdueRelevantCount },
  ];
}

export function suppliesClearCopy(): string {
  return 'No open supplies.';
}

export function suppliesActiveMetrics(
  item: SupplyPulseItem,
): readonly PulseMetric[] {
  return [
    { label: 'Open', value: item.openCount },
    { label: 'Unclaimed', value: item.unclaimedOpenCount },
    { label: 'Claimed by you', value: item.claimedByMeCount },
  ];
}

export function maintenanceClearCopy(): string {
  return 'No open maintenance visible to you.';
}

export function maintenanceActiveCopy(item: MaintenancePulseItem): string {
  const count = item.openVisibleCount;
  if (count === 1) {
    return '1 open item visible to you';
  }
  return `${count} open items visible to you`;
}
