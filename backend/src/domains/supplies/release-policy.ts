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
 * Specialized supply.release_claim capability. Active Roommate and Admin share
 * the same grant only when the actor's exact Membership owns the locked claim.
 * There is no Admin override and no User-identity ownership.
 */
export const SUPPLY_RELEASE_CLAIM_CAPABLE_ROLES = [
  'ROOMMATE',
  'ADMIN',
] as const;

export type SupplyReleaseClaimDenial =
  'HOME_SCOPE_MISMATCH' | 'CLAIM_HOME_MISMATCH' | 'SUPPLY_RELEASE_CLAIM_DENIED';

export function isSupplyReleaseClaimCapableRole(
  role: MembershipRole,
): role is (typeof SUPPLY_RELEASE_CLAIM_CAPABLE_ROLES)[number] {
  return (
    SUPPLY_RELEASE_CLAIM_CAPABLE_ROLES as readonly MembershipRole[]
  ).includes(role);
}

/**
 * Pure supply.release_claim policy. Resource-aware: claimant Membership must
 * match the locked actor tenure. Does not query persistence, inspect Express,
 * or choose an HTTP status.
 */
export function decideSupplyReleaseClaim(input: {
  actor: Pick<ActiveHomeActor, 'homeId' | 'membershipId' | 'role'>;
  targetHomeId: string;
  claimHomeId: string;
  claimantMembershipId: string;
}): AuthorizationDecision<SupplyReleaseClaimDenial> {
  if (input.actor.homeId !== input.targetHomeId) {
    return deny('HOME_SCOPE_MISMATCH');
  }
  if (
    input.claimHomeId !== input.targetHomeId ||
    input.claimHomeId !== input.actor.homeId
  ) {
    return deny('CLAIM_HOME_MISMATCH');
  }
  if (!isSupplyReleaseClaimCapableRole(input.actor.role)) {
    return deny('SUPPLY_RELEASE_CLAIM_DENIED');
  }
  if (input.actor.membershipId !== input.claimantMembershipId) {
    return deny('SUPPLY_RELEASE_CLAIM_DENIED');
  }
  return allow();
}
