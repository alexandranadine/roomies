import type { MembershipRole } from '../../platform/authz/context.js';
import {
  allow,
  deny,
  type AuthorizationDecision,
} from '../../platform/authz/decision.js';
import { isHomeAdmin } from '../../platform/authz/home-role.js';

export type InvitationCreateDenial = 'INVITATION_CREATE_DENIED';

/**
 * Pure invitation.create capability. ADMIN only. Does not query persistence
 * or choose an HTTP status. Caller must pass the transaction-current role.
 */
export function decideInvitationCreate(input: {
  actorRole: MembershipRole;
}): AuthorizationDecision<InvitationCreateDenial> {
  if (isHomeAdmin({ role: input.actorRole })) {
    return allow();
  }
  return deny('INVITATION_CREATE_DENIED');
}
