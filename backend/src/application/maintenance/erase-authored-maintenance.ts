import { MaintenancePersistenceError } from '../../domains/maintenance/errors.js';
import {
  createMaintenanceRepository,
  type AuthoredMaintenanceSourceRef,
  type MaintenanceRepository,
} from '../../domains/maintenance/repository.js';
import type {
  TransactionContext,
  TransactionPool,
} from '../../platform/persistence/transaction.js';
import {
  createDeleteActivitiesForSourceFromPool,
  type DeleteActivitiesForSource,
} from '../activity/delete-activities-for-source.js';
import {
  createDeleteNotificationsForSourceFromPool,
  type DeleteNotificationsForSource,
} from '../notifications/delete-notifications-for-source.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Maintenance-owned public account-erasure port. Accepts exact historical
 * Membership IDs and the caller-owned transaction. Discovers authored
 * MaintenanceEntry rows by createdByMembershipId only. Does not discover
 * User tenures. Does not lock Homes or Users.
 */
export type EraseAuthoredMaintenanceInput = Readonly<{
  membershipIds: readonly string[];
}>;

export type EraseAuthoredMaintenance = (
  tx: TransactionContext,
  input: EraseAuthoredMaintenanceInput,
) => Promise<void>;

export type EraseAuthoredMaintenanceDependencies = Readonly<{
  deleteNotificationsForSource: DeleteNotificationsForSource;
  deleteActivitiesForSource: DeleteActivitiesForSource;
  maintenance: Pick<
    MaintenanceRepository,
    | 'lockAuthoredSourcesForErase'
    | 'deleteAudienceForErasedSource'
    | 'deleteAuthoredSource'
  >;
}>;

function uniqueSortedMembershipIds(
  membershipIds: readonly string[],
): readonly string[] {
  const unique = new Set<string>();
  for (const membershipId of membershipIds) {
    if (typeof membershipId !== 'string' || !UUID_PATTERN.test(membershipId)) {
      throw new MaintenancePersistenceError();
    }
    unique.add(membershipId);
  }
  return Object.freeze(
    [...unique].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

async function eraseOneSource(
  tx: TransactionContext,
  source: AuthoredMaintenanceSourceRef,
  deps: EraseAuthoredMaintenanceDependencies,
): Promise<void> {
  await deps.deleteNotificationsForSource(tx, {
    homeId: source.homeId,
    sourceEntityType: 'MAINTENANCE',
    sourceEntityId: source.id,
  });
  await deps.deleteActivitiesForSource(tx, {
    homeId: source.homeId,
    sourceEntityType: 'MAINTENANCE',
    sourceEntityId: source.id,
  });
  await deps.maintenance.deleteAudienceForErasedSource(tx, source);
  await deps.maintenance.deleteAuthoredSource(tx, source);
}

/**
 * Erases Maintenance authored by the supplied exact Membership IDs.
 *
 * Order inside the caller-owned transaction, per locked source:
 * Notifications → ActivityRecipients → Activities → MaintenanceAudience →
 * MaintenanceEntry. Empty membership input is a no-op. No independent
 * transaction is opened.
 */
export function createEraseAuthoredMaintenance(
  deps: EraseAuthoredMaintenanceDependencies,
): EraseAuthoredMaintenance {
  return async (tx, input) => {
    const membershipIds = uniqueSortedMembershipIds(input.membershipIds);
    if (membershipIds.length === 0) {
      return;
    }

    const sources = await deps.maintenance.lockAuthoredSourcesForErase(tx, {
      membershipIds,
    });
    for (const source of sources) {
      await eraseOneSource(tx, source, deps);
    }
  };
}

export function createEraseAuthoredMaintenanceFromPool(
  pool: TransactionPool,
): EraseAuthoredMaintenance {
  return createEraseAuthoredMaintenance({
    deleteNotificationsForSource:
      createDeleteNotificationsForSourceFromPool(pool),
    deleteActivitiesForSource: createDeleteActivitiesForSourceFromPool(pool),
    maintenance: createMaintenanceRepository(
      pool as Parameters<typeof createMaintenanceRepository>[0],
    ),
  });
}
