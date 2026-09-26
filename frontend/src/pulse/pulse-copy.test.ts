import { describe, expect, it } from 'vitest';
import {
  compactPulseMetrics,
  glancePulseMetrics,
  maintenanceActiveCopy,
  maintenanceClearCopy,
  pulseOverallState,
  pulseStateLabel,
  barPulseMetrics,
  suppliesActiveMetrics,
  suppliesClearCopy,
  tasksActiveMetrics,
  tasksClearCopy,
} from './pulse-copy.js';
import type { HousePulseDto } from './pulse-api.js';
import {
  clearMaintenanceItem,
  clearSuppliesItem,
  clearTasksItem,
} from './test-fixtures.js';

describe('pulse copy', () => {
  it('labels CLEAR and ACTIVE without urgency vocabulary', () => {
    expect(pulseStateLabel('CLEAR')).toBe('Clear');
    expect(pulseStateLabel('ACTIVE')).toBe('Active');
    expect(pulseStateLabel('ACTIVE')).not.toMatch(/urgent|warning|danger/i);
  });

  it('uses requester-relevant Task CLEAR wording', () => {
    expect(tasksClearCopy()).toBe('Nothing needs attention.');
    expect(tasksClearCopy()).not.toMatch(/no open tasks in the house/i);
  });

  it('exposes Task counters without deriving a Home total', () => {
    const metrics = tasksActiveMetrics(
      clearTasksItem({
        state: 'ACTIVE',
        assignedOpenCount: 2,
        unassignedOpenCount: 1,
        dueTodayRelevantCount: 4,
        overdueRelevantCount: 3,
      }),
    );
    expect(metrics).toEqual([
      { label: 'Assigned to you', value: 2 },
      { label: 'Unassigned', value: 1 },
      { label: 'Due today', value: 4 },
      { label: 'Overdue', value: 3 },
    ]);
    expect(metrics.reduce((sum, m) => sum + m.value, 0)).not.toBe(
      metrics.find((m) => m.label === 'Assigned to you')?.value,
    );
  });

  it('presents Supply counters and CLEAR copy', () => {
    expect(suppliesClearCopy()).toBe('No open supplies.');
    expect(
      suppliesActiveMetrics(
        clearSuppliesItem({
          state: 'ACTIVE',
          openCount: 5,
          unclaimedOpenCount: 2,
          claimedByMeCount: 1,
        }),
      ),
    ).toEqual([
      { label: 'Open', value: 5 },
      { label: 'Unclaimed', value: 2 },
      { label: 'Claimed by you', value: 1 },
    ]);
  });

  it('scopes Maintenance copy to visibility with singular and plural', () => {
    expect(maintenanceClearCopy()).toBe('No open maintenance visible to you.');
    expect(maintenanceClearCopy()).not.toMatch(
      /no maintenance issues in the house/i,
    );
    expect(
      maintenanceActiveCopy(clearMaintenanceItem({ openVisibleCount: 1 })),
    ).toBe('1 open item visible to you');
    expect(
      maintenanceActiveCopy(clearMaintenanceItem({ openVisibleCount: 2 })),
    ).toBe('2 open items visible to you');
  });

  it('compact metrics use only Pulse DTO fields', () => {
    const pulse: HousePulseDto = {
      generatedAt: '2026-09-14T04:00:00.000Z',
      homeLocalDate: '2026-09-14',
      items: [
        clearTasksItem({
          state: 'ACTIVE',
          assignedOpenCount: 2,
          unassignedOpenCount: 1,
          dueTodayRelevantCount: 4,
          overdueRelevantCount: 3,
        }),
        clearSuppliesItem({ state: 'ACTIVE', openCount: 5 }),
        clearMaintenanceItem({ state: 'ACTIVE', openVisibleCount: 2 }),
      ],
    };
    expect(compactPulseMetrics(pulse).map((metric) => metric.label)).toEqual([
      'Assigned to you',
      'Unassigned',
      'Due today',
      'Overdue',
      'Supplies',
      'Maintenance',
    ]);
    expect(glancePulseMetrics(pulse).map((metric) => metric.label)).toEqual([
      'Overdue',
      'Unassigned tasks',
      'Maintenance',
    ]);
    expect(barPulseMetrics(pulse).map((metric) => metric.label)).toEqual([
      'Due today',
      'Supplies',
    ]);
    expect(pulseOverallState(pulse)).toBe('ACTIVE');
  });
});
