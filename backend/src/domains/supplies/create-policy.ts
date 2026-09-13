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
 * Ordinary supply.create capability. Active Roommate and Admin share the same
 * grant. There is no Admin bypass and no inactive-Membership grant.
 */
export const SUPPLY_CREATE_CAPABLE_ROLES = ['ROOMMATE', 'ADMIN'] as const;

export type SupplyCreateDenial = 'HOME_SCOPE_MISMATCH' | 'SUPPLY_CREATE_DENIED';

export function isSupplyCreateCapableRole(
  role: MembershipRole,
): role is (typeof SUPPLY_CREATE_CAPABLE_ROLES)[number] {
  return (SUPPLY_CREATE_CAPABLE_ROLES as readonly MembershipRole[]).includes(
    role,
  );
}

/**
 * Pure supply.create policy. Does not query persistence, inspect Express, or
 * choose an HTTP status. Caller must pass the transaction-current actor.
 */
export function decideSupplyCreate(input: {
  actor: Pick<ActiveHomeActor, 'homeId' | 'role'>;
  targetHomeId: string;
}): AuthorizationDecision<SupplyCreateDenial> {
  if (input.actor.homeId !== input.targetHomeId) {
    return deny('HOME_SCOPE_MISMATCH');
  }
  if (isSupplyCreateCapableRole(input.actor.role)) {
    return allow();
  }
  return deny('SUPPLY_CREATE_DENIED');
}
