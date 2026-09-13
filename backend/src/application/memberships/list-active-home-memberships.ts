import { decideMembershipListActive } from '../../domains/memberships/list-active-policy.js';
import {
  createActiveHomeMembershipsReader,
  type ActiveHomeMembershipsReader,
} from '../../domains/memberships/list-active-home-memberships-reader.js';
import type {
  ActiveHomeMembershipListItem,
  ListActiveHomeMembershipsInput,
} from '../../domains/memberships/active-home-membership-list.js';
import {
  AuthorizationIntegrityError,
  ConcealedNotFoundError,
} from '../../platform/authz/errors.js';
import type { TransactionPool } from '../../platform/persistence/transaction.js';

export type { ListActiveHomeMembershipsInput };

export type ListActiveHomeMembershipsResult =
  readonly ActiveHomeMembershipListItem[];

/**
 * Authorized active-Home Membership list. Uses membership.list_active, then
 * the Home-scoped reader. Does not filter, sort, or hide self in application
 * code.
 */
export async function listActiveHomeMemberships(
  input: ListActiveHomeMembershipsInput,
  memberships: Pick<ActiveHomeMembershipsReader, 'listActiveByHome'>,
): Promise<ListActiveHomeMembershipsResult> {
  const decision = decideMembershipListActive({
    actor: input.actor,
    targetHomeId: input.homeId,
  });
  if (!decision.allowed) {
    throw new ConcealedNotFoundError();
  }

  const rows = await memberships.listActiveByHome(input.homeId);
  if (!rows.some((row) => row.membershipId === input.actor.membershipId)) {
    throw new AuthorizationIntegrityError();
  }
  return rows;
}

export function createListActiveHomeMembershipsFromPool(
  pool: TransactionPool,
): (
  input: ListActiveHomeMembershipsInput,
) => Promise<ListActiveHomeMembershipsResult> {
  const reader = createActiveHomeMembershipsReader(
    pool as unknown as Parameters<typeof createActiveHomeMembershipsReader>[0],
  );
  return (input) => listActiveHomeMemberships(input, reader);
}
