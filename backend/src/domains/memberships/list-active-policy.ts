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
 * Ordinary membership.list_active capability. Active Roommate and Admin share
 * the same grant. There is no Admin bypass and no inactive-Membership grant.
 */
export const MEMBERSHIP_LIST_ACTIVE_CAPABLE_ROLES = [
  'ROOMMATE',
  'ADMIN',
] as const;

export type MembershipListActiveDenial =
  'HOME_SCOPE_MISMATCH' | 'MEMBERSHIP_LIST_ACTIVE_DENIED';

export function isMembershipListActiveCapableRole(
  role: MembershipRole,
): role is (typeof MEMBERSHIP_LIST_ACTIVE_CAPABLE_ROLES)[number] {
  return (
    MEMBERSHIP_LIST_ACTIVE_CAPABLE_ROLES as readonly MembershipRole[]
  ).includes(role);
}

/**
 * Pure membership.list_active policy. Does not query persistence, inspect
 * Express, or choose an HTTP status.
 */
export function decideMembershipListActive(input: {
  actor: Pick<ActiveHomeActor, 'homeId' | 'role'>;
  targetHomeId: string;
}): AuthorizationDecision<MembershipListActiveDenial> {
  if (input.actor.homeId !== input.targetHomeId) {
    return deny('HOME_SCOPE_MISMATCH');
  }
  if (isMembershipListActiveCapableRole(input.actor.role)) {
    return allow();
  }
  return deny('MEMBERSHIP_LIST_ACTIVE_DENIED');
}
