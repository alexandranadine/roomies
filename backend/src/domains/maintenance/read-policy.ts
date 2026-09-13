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
 * Ordinary maintenance.read capability. Active Roommate and Admin share the
 * same grant. Capability never substitutes for row visibility.
 */
export const MAINTENANCE_READ_CAPABLE_ROLES = ['ROOMMATE', 'ADMIN'] as const;

export type MaintenanceReadDenial =
  'HOME_SCOPE_MISMATCH' | 'MAINTENANCE_READ_DENIED';

export function isMaintenanceReadCapableRole(
  role: MembershipRole,
): role is (typeof MAINTENANCE_READ_CAPABLE_ROLES)[number] {
  return (MAINTENANCE_READ_CAPABLE_ROLES as readonly MembershipRole[]).includes(
    role,
  );
}

/**
 * Pure maintenance.read policy. Does not query persistence, inspect Express,
 * or choose an HTTP status.
 */
export function decideMaintenanceRead(input: {
  actor: Pick<ActiveHomeActor, 'homeId' | 'role'>;
  targetHomeId: string;
}): AuthorizationDecision<MaintenanceReadDenial> {
  if (input.actor.homeId !== input.targetHomeId) {
    return deny('HOME_SCOPE_MISMATCH');
  }
  if (isMaintenanceReadCapableRole(input.actor.role)) {
    return allow();
  }
  return deny('MAINTENANCE_READ_DENIED');
}
