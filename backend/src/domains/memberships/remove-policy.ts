import type { MembershipRole } from '../../platform/authz/context.js';
import {
  allow,
  deny,
  type AuthorizationDecision,
} from '../../platform/authz/decision.js';
import { isHomeAdmin } from '../../platform/authz/home-role.js';
import {
  decideProposedAdminInvariant,
  type ProposedAdminInvariantDenial,
} from './role-policy.js';

export type MembershipRemoveDenial = 'MEMBERSHIP_REMOVE_DENIED';

export type MembershipRemoveSelfDenial = 'MEMBERSHIP_REMOVE_SELF';

export type MembershipRemoveTargetDenial = 'MEMBERSHIP_REMOVE_TARGET_CONCEALED';

/**
 * Pure membership.remove capability. Only a transaction-current Admin may
 * remove another Membership. Does not query persistence or choose HTTP status.
 */
export function decideMembershipRemove(input: {
  actorRole: MembershipRole;
}): AuthorizationDecision<MembershipRemoveDenial> {
  if (isHomeAdmin({ role: input.actorRole })) {
    return allow();
  }
  return deny('MEMBERSHIP_REMOVE_DENIED');
}

/**
 * Pure exact-id target presence check against the already-locked active set.
 * Never resolves by user identity or remaps an ended tenure.
 */
export function decideMembershipRemoveTarget(input: {
  pathMembershipId: string;
  lockedActiveMembershipIds: readonly string[];
}): AuthorizationDecision<MembershipRemoveTargetDenial> {
  if (!input.lockedActiveMembershipIds.includes(input.pathMembershipId)) {
    return deny('MEMBERSHIP_REMOVE_TARGET_CONCEALED');
  }
  return allow();
}

/**
 * Pure membership.remove self-target check. Identifies self only by exact
 * locked Membership id. Self-remove is never reinterpreted as leave.
 */
export function decideMembershipRemoveSelf(input: {
  actorMembershipId: string;
  pathMembershipId: string;
}): AuthorizationDecision<MembershipRemoveSelfDenial> {
  if (input.actorMembershipId === input.pathMembershipId) {
    return deny('MEMBERSHIP_REMOVE_SELF');
  }
  return allow();
}

/**
 * Pure proposed-state Admin preservation after removing the exact target
 * Membership. Does not archive, promote, or repair. A current zero-Admin
 * Home is not this function's job.
 */
export function decideMembershipRemoveProposed(input: {
  targetMembershipId: string;
  activeMemberships: readonly { id: string; role: MembershipRole }[];
}): AuthorizationDecision<ProposedAdminInvariantDenial> {
  return decideProposedAdminInvariant({
    proposedActiveMemberships: input.activeMemberships.filter(
      (membership) => membership.id !== input.targetMembershipId,
    ),
  });
}
