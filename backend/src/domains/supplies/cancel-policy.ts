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
 * Ordinary supply.cancel capability. Active Roommate and Admin share the same
 * grant. There is no Admin bypass, creator ownership, claimant ownership, or
 * inactive-Membership grant.
 */
export const SUPPLY_CANCEL_CAPABLE_ROLES = ['ROOMMATE', 'ADMIN'] as const;

export type SupplyCancelDenial = 'HOME_SCOPE_MISMATCH' | 'SUPPLY_CANCEL_DENIED';

export function isSupplyCancelCapableRole(
  role: MembershipRole,
): role is (typeof SUPPLY_CANCEL_CAPABLE_ROLES)[number] {
  return (SUPPLY_CANCEL_CAPABLE_ROLES as readonly MembershipRole[]).includes(
    role,
  );
}

/**
 * Pure supply.cancel policy. Does not query persistence, inspect Express, or
 * choose an HTTP status. Caller must pass the transaction-current actor.
 */
export function decideSupplyCancel(input: {
  actor: Pick<ActiveHomeActor, 'homeId' | 'role'>;
  targetHomeId: string;
}): AuthorizationDecision<SupplyCancelDenial> {
  if (input.actor.homeId !== input.targetHomeId) {
    return deny('HOME_SCOPE_MISMATCH');
  }
  if (isSupplyCancelCapableRole(input.actor.role)) {
    return allow();
  }
  return deny('SUPPLY_CANCEL_DENIED');
}
