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
 * Ordinary maintenance.resolve capability. Active Roommate and Admin share the
 * same grant. There is no Admin bypass, no creator-only grant, and no
 * inactive-Membership grant. Visibility is a separate repository predicate.
 */
export const MAINTENANCE_RESOLVE_CAPABLE_ROLES = ['ROOMMATE', 'ADMIN'] as const;

export type MaintenanceResolveDenial =
  'HOME_SCOPE_MISMATCH' | 'MAINTENANCE_RESOLVE_DENIED';

export function isMaintenanceResolveCapableRole(
  role: MembershipRole,
): role is (typeof MAINTENANCE_RESOLVE_CAPABLE_ROLES)[number] {
  return (
    MAINTENANCE_RESOLVE_CAPABLE_ROLES as readonly MembershipRole[]
  ).includes(role);
}

/**
 * Pure maintenance.resolve policy. Does not query persistence, inspect
 * Express, or choose an HTTP status. Caller must pass the
 * transaction-current actor.
 */
export function decideMaintenanceResolve(input: {
  actor: Pick<ActiveHomeActor, 'homeId' | 'role'>;
  targetHomeId: string;
}): AuthorizationDecision<MaintenanceResolveDenial> {
  if (input.actor.homeId !== input.targetHomeId) {
    return deny('HOME_SCOPE_MISMATCH');
  }
  if (isMaintenanceResolveCapableRole(input.actor.role)) {
    return allow();
  }
  return deny('MAINTENANCE_RESOLVE_DENIED');
}
