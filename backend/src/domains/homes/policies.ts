import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  allow,
  deny,
  type AuthorizationDecision,
} from '../../platform/authz/decision.js';
import type { LockedHomeStructure } from './locked-home-structure.js';

export type HomeReadDenialReason = 'HOME_SCOPE_MISMATCH';

/**
 * Pure home.read policy. Either active role may read. Does not query
 * persistence, inspect Express, or choose an HTTP status.
 */
export function decideHomeRead(input: {
  actor: ActiveHomeActor;
  targetHomeId: string;
}): AuthorizationDecision<HomeReadDenialReason> {
  if (input.actor.homeId === input.targetHomeId) {
    return allow();
  }
  return deny('HOME_SCOPE_MISMATCH');
}

export type ArchiveFinalMemberDenialReason =
  'ACTOR_NOT_ADMIN' | 'FINAL_MEMBER_REQUIRED' | 'SOLE_MEMBER_MISMATCH';

/**
 * Pure policy over transaction-current locked state. Structural-invariant
 * validation is deliberately performed by the application before this policy.
 */
export function decideArchiveFinalMember(
  locked: LockedHomeStructure,
): AuthorizationDecision<ArchiveFinalMemberDenialReason> {
  if (locked.actor.role !== 'ADMIN') {
    return deny('ACTOR_NOT_ADMIN');
  }
  if (locked.activeMemberships.length > 1) {
    return deny('FINAL_MEMBER_REQUIRED');
  }

  const sole = locked.activeMemberships[0];
  if (
    sole === undefined ||
    sole.id !== locked.actor.membershipId ||
    sole.userId !== locked.actor.userId ||
    sole.homeId !== locked.home.id
  ) {
    return deny('SOLE_MEMBER_MISMATCH');
  }

  return allow();
}
