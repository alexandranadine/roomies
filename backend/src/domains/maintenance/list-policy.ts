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
 * Ordinary maintenance.list capability. Active Roommate and Admin share the
 * same grant. Capability never substitutes for row visibility.
 */
export const MAINTENANCE_LIST_CAPABLE_ROLES = ['ROOMMATE', 'ADMIN'] as const;

export type MaintenanceListDenial =
  'HOME_SCOPE_MISMATCH' | 'MAINTENANCE_LIST_DENIED';

export function isMaintenanceListCapableRole(
  role: MembershipRole,
): role is (typeof MAINTENANCE_LIST_CAPABLE_ROLES)[number] {
  return (MAINTENANCE_LIST_CAPABLE_ROLES as readonly MembershipRole[]).includes(
    role,
  );
}

/**
 * Pure maintenance.list policy. Does not query persistence, inspect Express,
 * or choose an HTTP status.
 */
export function decideMaintenanceList(input: {
  actor: Pick<ActiveHomeActor, 'homeId' | 'role'>;
  targetHomeId: string;
}): AuthorizationDecision<MaintenanceListDenial> {
  if (input.actor.homeId !== input.targetHomeId) {
    return deny('HOME_SCOPE_MISMATCH');
  }
  if (isMaintenanceListCapableRole(input.actor.role)) {
    return allow();
  }
  return deny('MAINTENANCE_LIST_DENIED');
}
