import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { HousePulseSnapshot } from '../../domains/homes/find-house-pulse-snapshot.js';
import type { MaintenancePulseSummary } from '../../domains/maintenance/find-maintenance-pulse-summary.js';
import type { SupplyPulseSummary } from '../../domains/supplies/find-supply-pulse-summary.js';
import type { TaskPulseSummary } from '../../domains/tasks/find-task-pulse-summary.js';
import { parseHomeLocalDate } from '../../domains/tasks/home-local-date.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  getHousePulse,
  type GetHousePulseDependencies,
} from './get-house-pulse.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBERSHIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const GENERATED = new Date('2026-09-14T07:00:00.000Z');
const TX = {} as TransactionContext;

function actor(role: ActiveHomeActor['role'] = 'ROOMMATE'): ActiveHomeActor {
  return {
    userId: '11111111-1111-4111-8111-111111111111',
    membershipId: MEMBERSHIP,
    homeId: HOME,
    role,
  };
}

function emptyTasks(): TaskPulseSummary {
  return {
    assignedOpenCount: 0,
    unassignedOpenCount: 0,
    dueTodayRelevantCount: 0,
    overdueRelevantCount: 0,
  };
}

function emptySupplies(): SupplyPulseSummary {
  return {
    openCount: 0,
    unclaimedOpenCount: 0,
    claimedByMeCount: 0,
  };
}

function emptyMaintenance(): MaintenancePulseSummary {
  return { openVisibleCount: 0 };
}

function snapshot(
  overrides: Partial<HousePulseSnapshot> = {},
): HousePulseSnapshot {
  return {
    generatedAt: GENERATED,
    timezone: 'America/Los_Angeles',
    ...overrides,
  };
}

function deps(
  overrides: {
    snapshot?: HousePulseSnapshot | null;
    tasks?: TaskPulseSummary;
    supplies?: SupplyPulseSummary;
    maintenance?: MaintenancePulseSummary;
    afterTaskSummary?: (tx: TransactionContext) => Promise<void>;
    onTask?: (homeLocalDate: string) => void;
  } = {},
): GetHousePulseDependencies & {
  order: string[];
} {
  const order: string[] = [];
  return {
    order,
    snapshot: {
      findHousePulseSnapshot: () => {
        order.push('snapshot');
        return Promise.resolve(
          overrides.snapshot === undefined ? snapshot() : overrides.snapshot,
        );
      },
    },
    tasks: {
      findTaskPulseSummary: (_tx, input) => {
        order.push('tasks');
        overrides.onTask?.(input.homeLocalDate);
        return Promise.resolve(overrides.tasks ?? emptyTasks());
      },
    },
    supplies: {
      findSupplyPulseSummary: () => {
        order.push('supplies');
        return Promise.resolve(overrides.supplies ?? emptySupplies());
      },
    },
    maintenance: {
      findMaintenancePulseSummary: () => {
        order.push('maintenance');
        return Promise.resolve(overrides.maintenance ?? emptyMaintenance());
      },
    },
    runRepeatableRead: async (work) => {
      order.push('begin');
      return work(TX);
    },
    ...(overrides.afterTaskSummary !== undefined
      ? { afterTaskSummary: overrides.afterTaskSummary }
      : {}),
  };
}

void describe('getHousePulse', () => {
  void it('returns CLEAR sections with zero counters when nothing is open', async () => {
    const pulse = await getHousePulse({ actor: actor(), homeId: HOME }, deps());
    assert.equal(pulse.generatedAt.toISOString(), GENERATED.toISOString());
    assert.equal(pulse.homeLocalDate, '2026-09-14');
    assert.equal(pulse.items.length, 3);
    assert.deepEqual(
      pulse.items.map((item) => item.type),
      ['TASKS', 'SUPPLIES', 'MAINTENANCE'],
    );
    assert.deepEqual(pulse.items[0], {
      type: 'TASKS',
      state: 'CLEAR',
      assignedOpenCount: 0,
      unassignedOpenCount: 0,
      dueTodayRelevantCount: 0,
      overdueRelevantCount: 0,
    });
    assert.deepEqual(pulse.items[1], {
      type: 'SUPPLIES',
      state: 'CLEAR',
      openCount: 0,
      unclaimedOpenCount: 0,
      claimedByMeCount: 0,
    });
    assert.deepEqual(pulse.items[2], {
      type: 'MAINTENANCE',
      state: 'CLEAR',
      openVisibleCount: 0,
    });
    assert.equal(JSON.stringify(pulse).includes(HOME), false);
    assert.equal(JSON.stringify(pulse).includes(MEMBERSHIP), false);
    assert.equal(/score|rank|blame|unread/i.test(JSON.stringify(pulse)), false);
  });

  void it('derives each section state only from its own counters', async () => {
    const pulse = await getHousePulse(
      { actor: actor(), homeId: HOME },
      deps({
        tasks: {
          assignedOpenCount: 1,
          unassignedOpenCount: 0,
          dueTodayRelevantCount: 1,
          overdueRelevantCount: 0,
        },
        supplies: emptySupplies(),
        maintenance: { openVisibleCount: 2 },
      }),
    );
    assert.equal(pulse.items[0]?.state, 'ACTIVE');
    assert.equal(pulse.items[1]?.state, 'CLEAR');
    assert.equal(pulse.items[2]?.state, 'ACTIVE');
  });

  void it('derives homeLocalDate from the same generatedAt and Home timezone', async () => {
    let seenDate: string | undefined;
    const midnightUtc = new Date('2026-09-14T00:00:00.000Z');
    const pulse = await getHousePulse(
      { actor: actor(), homeId: HOME },
      deps({
        snapshot: snapshot({
          generatedAt: midnightUtc,
          timezone: 'America/Los_Angeles',
        }),
        onTask: (homeLocalDate) => {
          seenDate = homeLocalDate;
        },
      }),
    );
    assert.equal(pulse.generatedAt.toISOString(), midnightUtc.toISOString());
    assert.equal(pulse.homeLocalDate, parseHomeLocalDate('2026-09-13'));
    assert.equal(seenDate, '2026-09-13');
  });

  void it('uses the same rules for ROOMMATE and ADMIN', async () => {
    const shared = deps({
      tasks: {
        assignedOpenCount: 2,
        unassignedOpenCount: 1,
        dueTodayRelevantCount: 0,
        overdueRelevantCount: 1,
      },
      supplies: {
        openCount: 3,
        unclaimedOpenCount: 1,
        claimedByMeCount: 1,
      },
      maintenance: { openVisibleCount: 1 },
    });
    const roommate = await getHousePulse(
      { actor: actor('ROOMMATE'), homeId: HOME },
      shared,
    );
    const admin = await getHousePulse(
      { actor: actor('ADMIN'), homeId: HOME },
      shared,
    );
    assert.deepEqual(roommate.items, admin.items);
    assert.equal(roommate.items[0]?.state, 'ACTIVE');
    assert.equal(roommate.items[1]?.state, 'ACTIVE');
    assert.equal(roommate.items[2]?.state, 'ACTIVE');
  });

  void it('conceals a Home-scope mismatch without opening a transaction', async () => {
    const harness = deps();
    await assert.rejects(
      () => getHousePulse({ actor: actor(), homeId: OTHER }, harness),
      ConcealedNotFoundError,
    );
    assert.deepEqual(harness.order, []);
  });

  void it('conceals a missing snapshot without reading sections', async () => {
    const harness = deps({ snapshot: null });
    await assert.rejects(
      () => getHousePulse({ actor: actor(), homeId: HOME }, harness),
      ConcealedNotFoundError,
    );
    assert.deepEqual(harness.order, ['begin', 'snapshot']);
  });

  void it('reads Tasks before the optional barrier, then Supplies and Maintenance', async () => {
    const harness = deps({
      afterTaskSummary: () => {
        harness.order.push('barrier');
        return Promise.resolve();
      },
    });
    await getHousePulse({ actor: actor(), homeId: HOME }, harness);
    assert.deepEqual(harness.order, [
      'begin',
      'snapshot',
      'tasks',
      'barrier',
      'supplies',
      'maintenance',
    ]);
  });
});
