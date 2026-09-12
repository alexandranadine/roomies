import type { MembershipRole } from '../../platform/authz/context.js';
import {
  allow,
  deny,
  type AuthorizationDecision,
} from '../../platform/authz/decision.js';
import { isHomeAdmin } from '../../platform/authz/home-role.js';

export type MembershipChangeRoleDenial = 'MEMBERSHIP_CHANGE_ROLE_DENIED';

export type ProposedAdminInvariantDenial = 'LAST_ADMIN_REQUIRED';

/**
 * Pure membership.changeRole capability. Same-role requests still require
 * this decision. Does not query persistence or choose an HTTP status.
 */
export function decideMembershipChangeRole(input: {
  actorRole: MembershipRole;
}): AuthorizationDecision<MembershipChangeRoleDenial> {
  if (isHomeAdmin({ role: input.actorRole })) {
    return allow();
  }
  return deny('MEMBERSHIP_CHANGE_ROLE_DENIED');
}

/**
 * Pure proposed-state Admin preservation. Does not promote, demote, or
 * repair a snapshot. A current zero-Admin Home is not this function's job.
 */
export function decideProposedAdminInvariant(input: {
  proposedActiveMemberships: readonly { role: MembershipRole }[];
}): AuthorizationDecision<ProposedAdminInvariantDenial> {
  if (input.proposedActiveMemberships.length === 0) {
    return allow();
  }

  const activeAdminCount = input.proposedActiveMemberships.filter(
    (membership) => membership.role === 'ADMIN',
  ).length;

  if (activeAdminCount < 1) {
    return deny('LAST_ADMIN_REQUIRED');
  }

  return allow();
}
