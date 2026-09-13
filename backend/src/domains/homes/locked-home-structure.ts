import type { MembershipRole } from '../../platform/authz/context.js';

export type LockedHome = Readonly<{
  id: string;
}>;

export type LockedEntryHome = LockedHome &
  Readonly<{
    archived: boolean;
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

export type LockedHomeEntryStructure = Readonly<{
  home: LockedEntryHome;
  activeMemberships: readonly LockedActiveMembership[];
}>;

/**
 * Transaction-current Home structural snapshot. Not an HTTP/DTO type.
 */
export type LockedHomeStructure = Readonly<{
  home: LockedHome;
  actor: LockedHomeActor;
  activeMemberships: readonly LockedActiveMembership[];
}>;
