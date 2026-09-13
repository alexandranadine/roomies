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
 * Ordinary task.complete capability. Active Roommate and Admin share the same
 * grant. There is no Admin bypass and no inactive-Membership grant.
 */
export const TASK_COMPLETE_CAPABLE_ROLES = ['ROOMMATE', 'ADMIN'] as const;

export type TaskCompleteDenial = 'HOME_SCOPE_MISMATCH' | 'TASK_COMPLETE_DENIED';

export function isTaskCompleteCapableRole(
  role: MembershipRole,
): role is (typeof TASK_COMPLETE_CAPABLE_ROLES)[number] {
  return (TASK_COMPLETE_CAPABLE_ROLES as readonly MembershipRole[]).includes(
    role,
  );
}

/**
 * Pure task.complete policy. Does not query persistence, inspect Express, or
 * choose an HTTP status. Caller must pass the transaction-current actor.
 */
export function decideTaskComplete(input: {
  actor: Pick<ActiveHomeActor, 'homeId' | 'role'>;
  targetHomeId: string;
}): AuthorizationDecision<TaskCompleteDenial> {
  if (input.actor.homeId !== input.targetHomeId) {
    return deny('HOME_SCOPE_MISMATCH');
  }
  if (isTaskCompleteCapableRole(input.actor.role)) {
    return allow();
  }
  return deny('TASK_COMPLETE_DENIED');
}
