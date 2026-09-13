import type { MembershipRole } from '../../platform/authz/context.js';
import {
  allow,
  deny,
  type AuthorizationDecision,
} from '../../platform/authz/decision.js';
import { isHomeAdmin } from '../../platform/authz/home-role.js';

export type InvitationRevokeDenial = 'INVITATION_REVOKE_DENIED';

/**
 * Pure invitation.revoke capability. ADMIN only. Does not query persistence
 * or choose an HTTP status. Caller must pass the transaction-current role.
 */
export function decideInvitationRevoke(input: {
  actorRole: MembershipRole;
}): AuthorizationDecision<InvitationRevokeDenial> {
  if (isHomeAdmin({ role: input.actorRole })) {
    return allow();
  }
  return deny('INVITATION_REVOKE_DENIED');
}
