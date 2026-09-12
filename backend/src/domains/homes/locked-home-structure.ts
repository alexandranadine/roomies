import type { MembershipRole } from '../../platform/authz/context.js';

export type LockedHome = Readonly<{
  id: string;
}>;

export type LockedActiveMembership = Readonly<{
  id: string;
  userId: string;
  homeId: string;
  role: MembershipRole;
}>;

export type LockedHomeActor = Readonly<{
  userId: string;
  membershipId: string;
  homeId: string;
  role: MembershipRole;
}>;

/**
 * Transaction-current Home structural snapshot. Not an HTTP/DTO type.
 */
export type LockedHomeStructure = Readonly<{
  home: LockedHome;
  actor: LockedHomeActor;
  activeMemberships: readonly LockedActiveMembership[];
}>;
