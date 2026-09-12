import type {
  ActiveHomeActor,
  MembershipRole,
} from '../../platform/authz/context.js';

export type ChangeMembershipRoleInput = Readonly<{
  actor: ActiveHomeActor;
  homeId: string;
  membershipId: string;
  role: MembershipRole;
}>;
