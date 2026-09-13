import type {
  ActiveHomeActor,
  MembershipRole,
} from '../../platform/authz/context.js';
import {
  allow,
  deny,
  type AuthorizationDecision,
} from '../../platform/authz/decision.js';

/**
 * Ordinary supply.list capability. Active Roommate and Admin share the same
 * grant. There is no Admin bypass and no inactive-Membership grant.
 */
export const SUPPLY_LIST_CAPABLE_ROLES = ['ROOMMATE', 'ADMIN'] as const;

export type SupplyListDenial = 'HOME_SCOPE_MISMATCH' | 'SUPPLY_LIST_DENIED';

export function isSupplyListCapableRole(
  role: MembershipRole,
): role is (typeof SUPPLY_LIST_CAPABLE_ROLES)[number] {
  return (SUPPLY_LIST_CAPABLE_ROLES as readonly MembershipRole[]).includes(
    role,
  );
}

/**
 * Pure supply.list policy. Does not query persistence, inspect Express, or
 * choose an HTTP status.
 */
export function decideSupplyList(input: {
  actor: Pick<ActiveHomeActor, 'homeId' | 'role'>;
  targetHomeId: string;
}): AuthorizationDecision<SupplyListDenial> {
  if (input.actor.homeId !== input.targetHomeId) {
    return deny('HOME_SCOPE_MISMATCH');
  }
  if (isSupplyListCapableRole(input.actor.role)) {
    return allow();
  }
  return deny('SUPPLY_LIST_DENIED');
}
