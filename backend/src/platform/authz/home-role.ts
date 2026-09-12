import type { ActiveHomeActor } from './context.js';

/**
 * Narrow Admin predicate. Feature policies must opt into Admin explicitly.
 * There is no global Admin bypass.
 */
export function isHomeAdmin(actor: Pick<ActiveHomeActor, 'role'>): boolean {
  return actor.role === 'ADMIN';
}

/**
 * Tenure identity comparison. Uses membershipId, never userId, so a rejoined
 * User does not inherit authority attached to an ended Membership.
 */
export function isActorMembership(
  actor: Pick<ActiveHomeActor, 'membershipId'>,
  membershipId: string,
): boolean {
  return actor.membershipId === membershipId;
}
