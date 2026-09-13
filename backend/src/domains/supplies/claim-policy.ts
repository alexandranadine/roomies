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
 * Ordinary supply.claim capability. Active Roommate and Admin share the same
 * grant. There is no Admin bypass and no inactive-Membership grant.
 */
export const SUPPLY_CLAIM_CAPABLE_ROLES = ['ROOMMATE', 'ADMIN'] as const;

export type SupplyClaimDenial = 'HOME_SCOPE_MISMATCH' | 'SUPPLY_CLAIM_DENIED';

export function isSupplyClaimCapableRole(
  role: MembershipRole,
): role is (typeof SUPPLY_CLAIM_CAPABLE_ROLES)[number] {
  return (SUPPLY_CLAIM_CAPABLE_ROLES as readonly MembershipRole[]).includes(
    role,
  );
}

/**
 * Pure supply.claim policy. Does not query persistence, inspect Express, or
 * choose an HTTP status. Caller must pass the transaction-current actor.
 */
export function decideSupplyClaim(input: {
  actor: Pick<ActiveHomeActor, 'homeId' | 'role'>;
  targetHomeId: string;
}): AuthorizationDecision<SupplyClaimDenial> {
  if (input.actor.homeId !== input.targetHomeId) {
    return deny('HOME_SCOPE_MISMATCH');
  }
  if (isSupplyClaimCapableRole(input.actor.role)) {
    return allow();
  }
  return deny('SUPPLY_CLAIM_DENIED');
}
