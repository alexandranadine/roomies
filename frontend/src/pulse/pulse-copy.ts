import type {
  HousePulseDto,
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

/**
 * Compact Home-summary metrics. Only values the Pulse DTO actually provides.
 * Does not invent people-home/away, events, or a summed task total.
 */
export function compactPulseMetrics(
  pulse: HousePulseDto,
): readonly PulseMetric[] {
  const [tasks, supplies, maintenance] = pulse.items;
  return [
    { label: 'Assigned to you', value: tasks.assignedOpenCount },
    { label: 'Unassigned', value: tasks.unassignedOpenCount },
    { label: 'Due today', value: tasks.dueTodayRelevantCount },
    { label: 'Overdue', value: tasks.overdueRelevantCount },
    { label: 'Supplies', value: supplies.openCount },
    { label: 'Maintenance', value: maintenance.openVisibleCount },
  ];
}

/** Mobile glance: the most actionable DTO counters. */
export function glancePulseMetrics(
  pulse: HousePulseDto,
): readonly PulseMetric[] {
  const [tasks, , maintenance] = pulse.items;
  return [
    { label: 'Overdue', value: tasks.overdueRelevantCount },
    { label: 'Unassigned tasks', value: tasks.unassignedOpenCount },
    { label: 'Maintenance', value: maintenance.openVisibleCount },
  ];
}

/** Extra DTO counters on the desktop horizontal Pulse bar. */
export function barPulseMetrics(
  pulse: HousePulseDto,
): readonly PulseMetric[] {
  const [tasks, supplies] = pulse.items;
  return [
    { label: 'Due today', value: tasks.dueTodayRelevantCount },
    { label: 'Supplies', value: supplies.openCount },
  ];
}

export function pulseOverallState(
  pulse: HousePulseDto,
): HousePulseSectionState {
  return pulse.items.some((item) => item.state === 'ACTIVE')
    ? 'ACTIVE'
    : 'CLEAR';
}
