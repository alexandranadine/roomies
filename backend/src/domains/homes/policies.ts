import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  allow,
  deny,
  type AuthorizationDecision,
} from '../../platform/authz/decision.js';

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
