import type { MaintenanceDetailProjection } from '../../domains/maintenance/maintenance.js';
import { decideMaintenanceRead } from '../../domains/maintenance/read-policy.js';
import {
  createMaintenanceRepository,
  type MaintenanceRepository,
} from '../../domains/maintenance/repository.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import type { TransactionPool } from '../../platform/persistence/transaction.js';

export type ReadMaintenanceEntryInput = Readonly<{
  actor: ActiveHomeActor;
  homeId: string;
  maintenanceEntryId: string;
}>;

export type ReadMaintenanceEntryRepository = Pick<
  MaintenanceRepository,
  'findVisibleByHomeAndId'
>;

/**
 * Authorized Home Maintenance detail. Uses maintenance.read, then the
 * repository's canonical visible lookup. Visibility identity is the actor
 * Membership ID.
 */
export async function readMaintenanceEntry(
  input: ReadMaintenanceEntryInput,
  maintenance: ReadMaintenanceEntryRepository,
): Promise<MaintenanceDetailProjection> {
  const decision = decideMaintenanceRead({
    actor: input.actor,
    targetHomeId: input.homeId,
  });
  if (!decision.allowed) {
    throw new ConcealedNotFoundError();
  }

  const entry = await maintenance.findVisibleByHomeAndId(
    input.homeId,
    input.maintenanceEntryId,
    input.actor.membershipId,
  );
  if (entry === null) {
    throw new ConcealedNotFoundError();
  }
  return entry;
}

export function createReadMaintenanceEntryFromPool(
  pool: TransactionPool,
): (input: ReadMaintenanceEntryInput) => Promise<MaintenanceDetailProjection> {
  const maintenance = createMaintenanceRepository(
    pool as Parameters<typeof createMaintenanceRepository>[0],
  );
  return (input) => readMaintenanceEntry(input, maintenance);
}
