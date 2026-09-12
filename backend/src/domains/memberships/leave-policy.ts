import type { MembershipRole } from '../../platform/authz/context.js';
import {
  allow,
  deny,
  type AuthorizationDecision,
} from '../../platform/authz/decision.js';

export type MembershipLeaveSelfDenial =
  'MEMBERSHIP_LEAVE_TARGET_CONCEALED' | 'MEMBERSHIP_LEAVE_NOT_SELF';

export type MembershipLeaveDenial =
  'LAST_ADMIN_REQUIRED' | 'LAST_ROOMMATE_REQUIRES_ARCHIVE';

/**
 * Pure membership.leave self-target check. Identifies self only by exact
 * locked Membership id, never by user identity. Does not query persistence
 * or choose an HTTP status.
 */
export function decideMembershipLeaveSelf(input: {
  actorMembershipId: string;
  pathMembershipId: string;
  lockedActiveMembershipIds: readonly string[];
}): AuthorizationDecision<MembershipLeaveSelfDenial> {
  const pathInLockedSet = input.lockedActiveMembershipIds.includes(
    input.pathMembershipId,
  );
  if (!pathInLockedSet) {
    return deny('MEMBERSHIP_LEAVE_TARGET_CONCEALED');
  }
  if (input.actorMembershipId !== input.pathMembershipId) {
    return deny('MEMBERSHIP_LEAVE_NOT_SELF');
  }
  return allow();
}

/**
 * Pure membership.leave structural policy. Assumes the current Home
 * invariant already passed and the actor/path self relationship already
 * held. Sole valid member takes precedence over last-Admin.
 */
export function decideMembershipLeave(input: {
  actorMembershipId: string;
  activeMemberships: readonly { id: string; role: MembershipRole }[];
}): AuthorizationDecision<MembershipLeaveDenial> {
  if (input.activeMemberships.length === 1) {
    return deny('LAST_ROOMMATE_REQUIRES_ARCHIVE');
  }

  const remaining = input.activeMemberships.filter(
    (membership) => membership.id !== input.actorMembershipId,
  );
  const remainingAdminCount = remaining.filter(
    (membership) => membership.role === 'ADMIN',
  ).length;

  if (remaining.length > 0 && remainingAdminCount < 1) {
    return deny('LAST_ADMIN_REQUIRED');
  }

  return allow();
}
