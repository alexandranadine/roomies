import {
  isMembershipRole,
  type MembershipRole,
} from '../../platform/authz/context.js';
import type { OutboxEventInput } from '../../platform/events/outbox-types.js';

export const MEMBERSHIP_ENDED_V1 = 'membership.ended.v1';
export const MEMBERSHIP_ROLE_CHANGED_V1 = 'membership.role_changed.v1';
export const MEMBERSHIP_STARTED_V1 = 'membership.started.v1';

export const MEMBERSHIP_ENDED_CAUSES = [
  'VOLUNTARY_LEAVE',
  'ADMIN_REMOVAL',
  'HOME_ARCHIVED',
] as const;

export type MembershipEndedCause = (typeof MEMBERSHIP_ENDED_CAUSES)[number];

export type MembershipEndedV1Payload = Readonly<{
  membershipId: string;
  cause: MembershipEndedCause;
}>;

export type MembershipRoleChangedV1Payload = Readonly<{
  membershipId: string;
  previousRole: MembershipRole;
  newRole: MembershipRole;
}>;

export type MembershipStartedV1Payload = Readonly<{
  membershipId: string;
  cause: 'INVITATION_ACCEPTED';
  invitationId: string;
}>;

export function isMembershipEndedCause(
  value: unknown,
): value is MembershipEndedCause {
  return (
    value === 'VOLUNTARY_LEAVE' ||
    value === 'ADMIN_REMOVAL' ||
    value === 'HOME_ARCHIVED'
  );
}

export function createMembershipEndedV1Event(
  input: Readonly<{
    eventId: string;
    occurredAt: Date;
    membershipId: string;
    cause: MembershipEndedCause;
    homeId?: string;
  }>,
): OutboxEventInput<typeof MEMBERSHIP_ENDED_V1, MembershipEndedV1Payload> {
  if (!isMembershipEndedCause(input.cause)) {
    throw new Error('Invalid membership ended cause');
  }

  return Object.freeze({
    eventId: input.eventId,
    eventType: MEMBERSHIP_ENDED_V1,
    occurredAt: input.occurredAt,
    ...(input.homeId === undefined ? {} : { homeId: input.homeId }),
    payload: Object.freeze({
      membershipId: input.membershipId,
      cause: input.cause,
    }),
  });
}

export function createMembershipRoleChangedV1Event(
  input: Readonly<{
    eventId: string;
    occurredAt: Date;
    membershipId: string;
    previousRole: MembershipRole;
    newRole: MembershipRole;
    homeId?: string;
  }>,
): OutboxEventInput<
  typeof MEMBERSHIP_ROLE_CHANGED_V1,
  MembershipRoleChangedV1Payload
> {
  if (
    !isMembershipRole(input.previousRole) ||
    !isMembershipRole(input.newRole)
  ) {
    throw new Error('Invalid membership role');
  }

  return Object.freeze({
    eventId: input.eventId,
    eventType: MEMBERSHIP_ROLE_CHANGED_V1,
    occurredAt: input.occurredAt,
    ...(input.homeId === undefined ? {} : { homeId: input.homeId }),
    payload: Object.freeze({
      membershipId: input.membershipId,
      previousRole: input.previousRole,
      newRole: input.newRole,
    }),
  });
}

export function createMembershipStartedV1Event(
  input: Readonly<{
    eventId: string;
    occurredAt: Date;
    homeId: string;
    membershipId: string;
    invitationId: string;
  }>,
): OutboxEventInput<typeof MEMBERSHIP_STARTED_V1, MembershipStartedV1Payload> {
  return Object.freeze({
    eventId: input.eventId,
    eventType: MEMBERSHIP_STARTED_V1,
    occurredAt: input.occurredAt,
    homeId: input.homeId,
    payload: Object.freeze({
      membershipId: input.membershipId,
      cause: 'INVITATION_ACCEPTED',
      invitationId: input.invitationId,
    }),
  });
}
