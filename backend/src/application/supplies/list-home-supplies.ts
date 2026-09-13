import { decideSupplyList } from '../../domains/supplies/list-policy.js';
import {
  createSupplyRepository,
  type SupplyRepository,
} from '../../domains/supplies/repository.js';
import type {
  SupplyEntry,
  SupplyEntryStatus,
} from '../../domains/supplies/supply.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import type { TransactionPool } from '../../platform/persistence/transaction.js';

export type ListHomeSuppliesInput = Readonly<{
  actor: ActiveHomeActor;
  homeId: string;
  status?: SupplyEntryStatus;
}>;

export type ListHomeSuppliesRepository = Pick<
  SupplyRepository,
  | 'listOpenEntriesByHome'
  | 'listSupplyEntriesByHome'
  | 'listSupplyEntriesByHomeAndStatus'
>;

/**
 * Authorized Home SupplyEntry list. Uses supply.list. Does not take
 * structural locks, join claims, or emit events.
 */
export async function listHomeSupplies(
  input: ListHomeSuppliesInput,
  supplies: ListHomeSuppliesRepository,
): Promise<readonly SupplyEntry[]> {
  const decision = decideSupplyList({
    actor: input.actor,
    targetHomeId: input.homeId,
  });
  if (!decision.allowed) {
    throw new ConcealedNotFoundError();
  }

  if (input.status === undefined) {
    return supplies.listSupplyEntriesByHome(input.homeId);
  }
  if (input.status === 'OPEN') {
    return supplies.listOpenEntriesByHome(input.homeId);
  }
  return supplies.listSupplyEntriesByHomeAndStatus(input.homeId, input.status);
}

export function createListHomeSuppliesFromPool(
  pool: TransactionPool,
): (input: ListHomeSuppliesInput) => Promise<readonly SupplyEntry[]> {
  const supplies = createSupplyRepository(
    pool as Parameters<typeof createSupplyRepository>[0],
  );
  return (input) => listHomeSupplies(input, supplies);
}
