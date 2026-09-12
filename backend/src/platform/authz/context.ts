/**
 * Roomies-owned Home authorization context.
 *
 * Construction of ActiveHomeActor certifies, at resolution time:
 * - the Membership belongs to userId;
 * - the Membership belongs to homeId;
 * - ended_at IS NULL;
 * - the Home has archived_at IS NULL;
 * - membershipId is the current tenure.
 *
 * This type is not a Better Auth session and is never an HTTP/DTO field.
 */
export const MEMBERSHIP_ROLES = ['ROOMMATE', 'ADMIN'] as const;

export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export type ActiveHomeActor = Readonly<{
  userId: string;
  membershipId: string;
  homeId: string;
  role: MembershipRole;
}>;

export type ActiveHomeActorResolver = {
  resolve(input: {
    userId: string;
    homeId: string;
  }): Promise<ActiveHomeActor | null>;
};

export function isMembershipRole(value: unknown): value is MembershipRole {
  return value === 'ROOMMATE' || value === 'ADMIN';
}

export function isActiveHomeActor(value: unknown): value is ActiveHomeActor {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const actor = value as Record<string, unknown>;
  return (
    typeof actor['userId'] === 'string' &&
    actor['userId'].length > 0 &&
    typeof actor['membershipId'] === 'string' &&
    actor['membershipId'].length > 0 &&
    typeof actor['homeId'] === 'string' &&
    actor['homeId'].length > 0 &&
    isMembershipRole(actor['role'])
  );
}
