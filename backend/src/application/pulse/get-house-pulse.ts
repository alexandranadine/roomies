import { Temporal } from '@js-temporal/polyfill';
import {
  findHousePulseSnapshot,
  type FindHousePulseSnapshot,
} from '../../domains/homes/find-house-pulse-snapshot.js';
import {
  findMaintenancePulseSummary,
  type FindMaintenancePulseSummary,
} from '../../domains/maintenance/find-maintenance-pulse-summary.js';
import { decideHousePulseRead } from '../../domains/pulse/list-policy.js';
import {
  housePulseSectionState,
  type HousePulse,
} from '../../domains/pulse/house-pulse.js';
import {
  findSupplyPulseSummary,
  type FindSupplyPulseSummary,
} from '../../domains/supplies/find-supply-pulse-summary.js';
import { homeLocalDateFromInstant } from '../../domains/tasks/home-local-date.js';
import {
  findTaskPulseSummary,
  type FindTaskPulseSummary,
} from '../../domains/tasks/find-task-pulse-summary.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import {
  runInRepeatableReadTransaction,
  type TransactionContext,
  type TransactionPool,
} from '../../platform/persistence/transaction.js';

export type GetHousePulseInput = Readonly<{
  actor: ActiveHomeActor;
  homeId: string;
}>;

export type HousePulseSnapshotPort = Readonly<{
  findHousePulseSnapshot: FindHousePulseSnapshot;
}>;

export type TaskPulseSummaryPort = Readonly<{
  findTaskPulseSummary: FindTaskPulseSummary;
}>;

export type SupplyPulseSummaryPort = Readonly<{
  findSupplyPulseSummary: FindSupplyPulseSummary;
}>;

export type MaintenancePulseSummaryPort = Readonly<{
  findMaintenancePulseSummary: FindMaintenancePulseSummary;
}>;

export type GetHousePulseDependencies = Readonly<{
  snapshot: HousePulseSnapshotPort;
  tasks: TaskPulseSummaryPort;
  supplies: SupplyPulseSummaryPort;
  maintenance: MaintenancePulseSummaryPort;
  runRepeatableRead: <T>(
    work: (tx: TransactionContext) => Promise<T>,
  ) => Promise<T>;
  /**
   * Test-only barrier after the first section. Production factory omits this.
   */
  afterTaskSummary?: (tx: TransactionContext) => Promise<void>;
}>;

/**
 * Recipient-specific House Pulse. One REPEATABLE READ snapshot: generatedAt,
 * Home timezone, Home-local date, then Task / Supply / Maintenance counts.
 */
export async function getHousePulse(
  input: GetHousePulseInput,
  deps: GetHousePulseDependencies,
): Promise<HousePulse> {
  const decision = decideHousePulseRead({
    actor: input.actor,
    targetHomeId: input.homeId,
  });
  if (!decision.allowed) {
    throw new ConcealedNotFoundError();
  }

  return deps.runRepeatableRead(async (tx) => {
    const snapshot = await deps.snapshot.findHousePulseSnapshot(tx, {
      homeId: input.homeId,
      requesterMembershipId: input.actor.membershipId,
    });
    if (snapshot === null) {
      throw new ConcealedNotFoundError();
    }

    const homeLocalDate = homeLocalDateFromInstant(
      Temporal.Instant.from(snapshot.generatedAt.toISOString()),
      snapshot.timezone,
    );

    const tasks = await deps.tasks.findTaskPulseSummary(tx, {
      homeId: input.homeId,
      requesterMembershipId: input.actor.membershipId,
      homeLocalDate,
    });
    if (deps.afterTaskSummary !== undefined) {
      await deps.afterTaskSummary(tx);
    }
    const supplies = await deps.supplies.findSupplyPulseSummary(tx, {
      homeId: input.homeId,
      requesterMembershipId: input.actor.membershipId,
    });
    const maintenance = await deps.maintenance.findMaintenancePulseSummary(tx, {
      homeId: input.homeId,
      requesterMembershipId: input.actor.membershipId,
    });

    const items: HousePulse['items'] = [
      Object.freeze({
        type: 'TASKS',
        state: housePulseSectionState(
          tasks.assignedOpenCount,
          tasks.unassignedOpenCount,
          tasks.dueTodayRelevantCount,
          tasks.overdueRelevantCount,
        ),
        assignedOpenCount: tasks.assignedOpenCount,
        unassignedOpenCount: tasks.unassignedOpenCount,
        dueTodayRelevantCount: tasks.dueTodayRelevantCount,
        overdueRelevantCount: tasks.overdueRelevantCount,
      }),
      Object.freeze({
        type: 'SUPPLIES',
        state: housePulseSectionState(
          supplies.openCount,
          supplies.unclaimedOpenCount,
          supplies.claimedByMeCount,
        ),
        openCount: supplies.openCount,
        unclaimedOpenCount: supplies.unclaimedOpenCount,
        claimedByMeCount: supplies.claimedByMeCount,
      }),
      Object.freeze({
        type: 'MAINTENANCE',
        state: housePulseSectionState(maintenance.openVisibleCount),
        openVisibleCount: maintenance.openVisibleCount,
      }),
    ];

    return Object.freeze({
      generatedAt: snapshot.generatedAt,
      homeLocalDate,
      items,
    });
  });
}

export function createGetHousePulseFromPool(
  pool: TransactionPool,
): (input: GetHousePulseInput) => Promise<HousePulse> {
  return (input) =>
    getHousePulse(input, {
      snapshot: { findHousePulseSnapshot },
      tasks: { findTaskPulseSummary },
      supplies: { findSupplyPulseSummary },
      maintenance: { findMaintenancePulseSummary },
      runRepeatableRead: (work) => runInRepeatableReadTransaction(pool, work),
    });
}
