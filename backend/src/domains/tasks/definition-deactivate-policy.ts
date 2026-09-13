import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  allow,
  deny,
  type AuthorizationDecision,
} from '../../platform/authz/decision.js';

export type TaskDefinitionDeactivateDenial =
  'HOME_SCOPE_MISMATCH' | 'TASK_DEFINITION_DEACTIVATE_DENIED';

/**
 * Exact creator-or-Admin deactivate rule.
 *
 * Allowed iff the transaction-current actor Membership is the definition's
 * creator tenure, or the locked actor role is ADMIN. Creator identity is
 * exact Membership id, never a User identity. Admin is the locked DB role, not a
 * generic bypass helper.
 */
export function decideTaskDefinitionDeactivate(input: {
  actor: Pick<ActiveHomeActor, 'homeId' | 'membershipId' | 'role'>;
  targetHomeId: string;
  creatorMembershipId: string;
}): AuthorizationDecision<TaskDefinitionDeactivateDenial> {
  if (input.actor.homeId !== input.targetHomeId) {
    return deny('HOME_SCOPE_MISMATCH');
  }
  const isExactCreator = input.actor.membershipId === input.creatorMembershipId;
  const isLockedAdmin = input.actor.role === 'ADMIN';
  if (isExactCreator || isLockedAdmin) {
    return allow();
  }
  return deny('TASK_DEFINITION_DEACTIVATE_DENIED');
}
