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
 * Ordinary supply.mark_obtained capability. Active Roommate and Admin share the
 * same grant. There is no Admin bypass, creator ownership, claimant ownership,
 * or inactive-Membership grant.
 */
export const SUPPLY_MARK_OBTAINED_CAPABLE_ROLES = [
  'ROOMMATE',
  'ADMIN',
] as const;

export type SupplyMarkObtainedDenial =
  'HOME_SCOPE_MISMATCH' | 'SUPPLY_MARK_OBTAINED_DENIED';

export function isSupplyMarkObtainedCapableRole(
  role: MembershipRole,
): role is (typeof SUPPLY_MARK_OBTAINED_CAPABLE_ROLES)[number] {
  return (
    SUPPLY_MARK_OBTAINED_CAPABLE_ROLES as readonly MembershipRole[]
  ).includes(role);
}

/**
 * Pure supply.mark_obtained policy. Does not query persistence, inspect
 * Express, or choose an HTTP status. Caller must pass the transaction-current
 * actor.
 */
export function decideSupplyMarkObtained(input: {
  actor: Pick<ActiveHomeActor, 'homeId' | 'role'>;
  targetHomeId: string;
}): AuthorizationDecision<SupplyMarkObtainedDenial> {
  if (input.actor.homeId !== input.targetHomeId) {
    return deny('HOME_SCOPE_MISMATCH');
  }
  if (isSupplyMarkObtainedCapableRole(input.actor.role)) {
    return allow();
  }
  return deny('SUPPLY_MARK_OBTAINED_DENIED');
}
