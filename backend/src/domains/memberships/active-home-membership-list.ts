import type { ActiveHomeActor } from '../../platform/authz/context.js';

/**
 * Safe active-roommate projection for the Home Membership picker.
 * Display name is AuthIdentity.name — the only existing human-readable field.
 */
export type ActiveHomeMembershipListItem = Readonly<{
  membershipId: string;
  name: string;
}>;

export type ListActiveHomeMembershipsInput = Readonly<{
  actor: ActiveHomeActor;
  homeId: string;
}>;
