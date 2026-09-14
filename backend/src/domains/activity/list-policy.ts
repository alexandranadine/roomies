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
 * Ordinary activity.list capability. Active Roommate and Admin share the
 * same grant. Capability never substitutes for row visibility.
 */
export const ACTIVITY_LIST_CAPABLE_ROLES = ['ROOMMATE', 'ADMIN'] as const;

export type ActivityListDenial = 'HOME_SCOPE_MISMATCH' | 'ACTIVITY_LIST_DENIED';

export function isActivityListCapableRole(
  role: MembershipRole,
): role is (typeof ACTIVITY_LIST_CAPABLE_ROLES)[number] {
  return (ACTIVITY_LIST_CAPABLE_ROLES as readonly MembershipRole[]).includes(
    role,
  );
}

/**
 * Pure activity.list policy. Does not query persistence, inspect Express,
 * or choose an HTTP status. Capability never widens row visibility.
 */
export function decideActivityList(input: {
  actor: Pick<ActiveHomeActor, 'homeId' | 'role'>;
  targetHomeId: string;
}): AuthorizationDecision<ActivityListDenial> {
  if (input.actor.homeId !== input.targetHomeId) {
    return deny('HOME_SCOPE_MISMATCH');
  }
  if (isActivityListCapableRole(input.actor.role)) {
    return allow();
  }
  return deny('ACTIVITY_LIST_DENIED');
}
