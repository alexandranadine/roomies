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
 * Ordinary maintenance.create capability. Active Roommate and Admin share the
 * same grant. There is no Admin bypass, no private-create privilege, and no
 * inactive-Membership grant.
 */
export const MAINTENANCE_CREATE_CAPABLE_ROLES = ['ROOMMATE', 'ADMIN'] as const;

export type MaintenanceCreateDenial =
  'HOME_SCOPE_MISMATCH' | 'MAINTENANCE_CREATE_DENIED';

export function isMaintenanceCreateCapableRole(
  role: MembershipRole,
): role is (typeof MAINTENANCE_CREATE_CAPABLE_ROLES)[number] {
  return (
    MAINTENANCE_CREATE_CAPABLE_ROLES as readonly MembershipRole[]
  ).includes(role);
}

/**
 * Pure maintenance.create policy. Does not query persistence, inspect Express,
 * or choose an HTTP status. Caller must pass the transaction-current actor.
 */
export function decideMaintenanceCreate(input: {
  actor: Pick<ActiveHomeActor, 'homeId' | 'role'>;
  targetHomeId: string;
}): AuthorizationDecision<MaintenanceCreateDenial> {
  if (input.actor.homeId !== input.targetHomeId) {
    return deny('HOME_SCOPE_MISMATCH');
  }
  if (isMaintenanceCreateCapableRole(input.actor.role)) {
    return allow();
  }
  return deny('MAINTENANCE_CREATE_DENIED');
}
