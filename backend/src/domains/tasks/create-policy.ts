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
 * Ordinary task.create capability. Active Roommate and Admin share the same
 * grant. There is no Admin bypass and no inactive-Membership grant.
 */
export const TASK_CREATE_CAPABLE_ROLES = ['ROOMMATE', 'ADMIN'] as const;

export type TaskCreateDenial = 'HOME_SCOPE_MISMATCH' | 'TASK_CREATE_DENIED';

export function isTaskCreateCapableRole(
  role: MembershipRole,
): role is (typeof TASK_CREATE_CAPABLE_ROLES)[number] {
  return (TASK_CREATE_CAPABLE_ROLES as readonly MembershipRole[]).includes(
    role,
  );
}

/**
 * Pure task.create policy. Does not query persistence, inspect Express, or
 * choose an HTTP status. Caller must pass the transaction-current actor.
 */
export function decideTaskCreate(input: {
  actor: Pick<ActiveHomeActor, 'homeId' | 'role'>;
  targetHomeId: string;
}): AuthorizationDecision<TaskCreateDenial> {
  if (input.actor.homeId !== input.targetHomeId) {
    return deny('HOME_SCOPE_MISMATCH');
  }
  if (isTaskCreateCapableRole(input.actor.role)) {
    return allow();
  }
  return deny('TASK_CREATE_DENIED');
}
