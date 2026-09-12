import type { ActiveHomeActor } from '../../platform/authz/context.js';

export type LeaveMembershipInput = Readonly<{
  actor: ActiveHomeActor;
  homeId: string;
  membershipId: string;
}>;
