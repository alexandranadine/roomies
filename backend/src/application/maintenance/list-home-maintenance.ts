import { MAINTENANCE_LIST_DEFAULT_LIMIT } from '../../domains/maintenance/cursor.js';
import { InvalidMaintenanceRequestError } from '../../domains/maintenance/errors.js';
import { decideMaintenanceList } from '../../domains/maintenance/list-policy.js';
import type { MaintenanceStatus } from '../../domains/maintenance/maintenance.js';
import {
  createMaintenanceRepository,
  type MaintenanceRepository,
  type MaintenanceVisiblePage,
} from '../../domains/maintenance/repository.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  InvalidRequestError,
} from '../../platform/authz/errors.js';
import type { TransactionPool } from '../../platform/persistence/transaction.js';

export type ListHomeMaintenanceInput = Readonly<{
  actor: ActiveHomeActor;
  homeId: string;
  limit?: number;
  cursor?: string;
  status?: MaintenanceStatus;
}>;

export type ListHomeMaintenanceRepository = Pick<
  MaintenanceRepository,
  'listVisibleByHome'
>;

/**
 * Authorized Home Maintenance list. Uses maintenance.list, then the
 * repository's canonical visible page. Does not filter, sort, or decode
 * cursors in application code.
 */
export async function listHomeMaintenance(
  input: ListHomeMaintenanceInput,
  maintenance: ListHomeMaintenanceRepository,
): Promise<MaintenanceVisiblePage> {
  const decision = decideMaintenanceList({
    actor: input.actor,
    targetHomeId: input.homeId,
  });
  if (!decision.allowed) {
    throw new ConcealedNotFoundError();
  }

  try {
    const page = await maintenance.listVisibleByHome({
      homeId: input.homeId,
      actorMembershipId: input.actor.membershipId,
      limit: input.limit ?? MAINTENANCE_LIST_DEFAULT_LIMIT,
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    });
    if (page === null) {
      throw new ConcealedNotFoundError();
    }
    return page;
  } catch (error) {
    if (error instanceof InvalidMaintenanceRequestError) {
      throw new InvalidRequestError();
    }
    throw error;
  }
}

export function createListHomeMaintenanceFromPool(
  pool: TransactionPool,
): (input: ListHomeMaintenanceInput) => Promise<MaintenanceVisiblePage> {
  const maintenance = createMaintenanceRepository(
    pool as Parameters<typeof createMaintenanceRepository>[0],
  );
  return (input) => listHomeMaintenance(input, maintenance);
}
