import type { ActiveHomeActor } from '../../platform/authz/context.js';

export type RemoveMembershipInput = Readonly<{
  actor: ActiveHomeActor;
  homeId: string;
  membershipId: string;
}>;
