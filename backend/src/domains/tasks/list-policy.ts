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
 * Ordinary task.list capability. Active Roommate and Admin share the same
 * grant. There is no Admin bypass and no inactive-Membership grant.
 */
export const TASK_LIST_CAPABLE_ROLES = ['ROOMMATE', 'ADMIN'] as const;

export type TaskListDenial = 'HOME_SCOPE_MISMATCH' | 'TASK_LIST_DENIED';

export function isTaskListCapableRole(
  role: MembershipRole,
): role is (typeof TASK_LIST_CAPABLE_ROLES)[number] {
  return (TASK_LIST_CAPABLE_ROLES as readonly MembershipRole[]).includes(role);
}

/**
 * Pure task.list policy. Does not query persistence, inspect Express, or
 * choose an HTTP status.
 */
export function decideTaskList(input: {
  actor: Pick<ActiveHomeActor, 'homeId' | 'role'>;
  targetHomeId: string;
}): AuthorizationDecision<TaskListDenial> {
  if (input.actor.homeId !== input.targetHomeId) {
    return deny('HOME_SCOPE_MISMATCH');
  }
  if (isTaskListCapableRole(input.actor.role)) {
    return allow();
  }
  return deny('TASK_LIST_DENIED');
}
