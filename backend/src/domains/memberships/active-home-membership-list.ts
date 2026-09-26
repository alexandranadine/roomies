import type {
  ActiveHomeActor,
  MembershipRole,
} from '../../platform/authz/context.js';

/**
 * Safe active-roommate projection for the Home Membership picker and roster.
 * Display name is AuthIdentity.name. Role is the current Membership tenure.
 */
export type ActiveHomeMembershipListItem = Readonly<{
  membershipId: string;
  name: string;
  role: MembershipRole;
}>;

export type ListActiveHomeMembershipsInput = Readonly<{
  actor: ActiveHomeActor;
  homeId: string;
}>;
