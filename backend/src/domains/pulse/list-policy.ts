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
 * Ordinary house_pulse.read capability. Active Roommate and Admin share the
 * same grant. There is no Admin bypass and no inactive-Membership grant.
 */
export const HOUSE_PULSE_READ_CAPABLE_ROLES = ['ROOMMATE', 'ADMIN'] as const;

export type HousePulseReadDenial =
  'HOME_SCOPE_MISMATCH' | 'HOUSE_PULSE_READ_DENIED';

export function isHousePulseReadCapableRole(
  role: MembershipRole,
): role is (typeof HOUSE_PULSE_READ_CAPABLE_ROLES)[number] {
  return (HOUSE_PULSE_READ_CAPABLE_ROLES as readonly MembershipRole[]).includes(
    role,
  );
}

/**
 * Pure house_pulse.read policy. Does not query persistence, inspect Express,
 * or choose an HTTP status.
 */
export function decideHousePulseRead(input: {
  actor: Pick<ActiveHomeActor, 'homeId' | 'role'>;
  targetHomeId: string;
}): AuthorizationDecision<HousePulseReadDenial> {
  if (input.actor.homeId !== input.targetHomeId) {
    return deny('HOME_SCOPE_MISMATCH');
  }
  if (isHousePulseReadCapableRole(input.actor.role)) {
    return allow();
  }
  return deny('HOUSE_PULSE_READ_DENIED');
}
