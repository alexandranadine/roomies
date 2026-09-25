import { FORMER_ROOMMATE_LABEL } from '../activity/activity-copy.js';
import type { ActiveHomeMembership } from '../homes/home-memberships-api.js';

export const CURRENT_USER_ASSIGNEE_LABEL = 'You';
export const UNASSIGNED_LABEL = 'Unassigned';
export const ASSIGNED_FALLBACK_LABEL = 'Assigned';

export type AssigneeLookup = {
  currentMembershipId: string;
  memberships: readonly ActiveHomeMembership[];
  membershipsReady: boolean;
};

/**
 * Display label for a Task/TaskDefinition assignedMembershipId.
 * Matches exact active Membership tenure only — never by name.
 */
export function assigneeDisplayName(
  assignedMembershipId: string | null,
  lookup: AssigneeLookup,
): string {
  if (assignedMembershipId === null) {
    return UNASSIGNED_LABEL;
  }
  if (!lookup.membershipsReady) {
    return ASSIGNED_FALLBACK_LABEL;
  }
  if (
    lookup.currentMembershipId.length > 0 &&
    assignedMembershipId === lookup.currentMembershipId
  ) {
    return CURRENT_USER_ASSIGNEE_LABEL;
  }
  const member = lookup.memberships.find(
    (row) => row.membershipId === assignedMembershipId,
  );
  if (member === undefined) {
    return FORMER_ROOMMATE_LABEL;
  }
  return member.name;
}

export function assigneePickerLabel(
  membership: ActiveHomeMembership,
  currentMembershipId: string,
): string {
  if (membership.membershipId === currentMembershipId) {
    return CURRENT_USER_ASSIGNEE_LABEL;
  }
  return membership.name;
}
