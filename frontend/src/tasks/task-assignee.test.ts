import { describe, expect, it } from 'vitest';
import { FORMER_ROOMMATE_LABEL } from '../activity/activity-copy.js';
import {
  ASSIGNED_FALLBACK_LABEL,
  assigneeDisplayName,
  assigneePickerLabel,
  CURRENT_USER_ASSIGNEE_LABEL,
  UNASSIGNED_LABEL,
} from './task-assignee.js';
import {
  TEST_ENDED_MEMBERSHIP,
  TEST_MEMBERSHIP_A,
  TEST_MEMBERSHIP_B,
  TEST_REJOIN_MEMBERSHIP,
} from './test-fixtures.js';

const lookup = {
  currentMembershipId: TEST_MEMBERSHIP_A,
  memberships: [
    { membershipId: TEST_MEMBERSHIP_A, name: 'Alex' },
    { membershipId: TEST_MEMBERSHIP_B, name: 'Jamie' },
    { membershipId: TEST_REJOIN_MEMBERSHIP, name: 'Alex' },
  ],
  membershipsReady: true,
};

describe('task assignee labels', () => {
  it('labels unassigned, current user, and active roommates', () => {
    expect(assigneeDisplayName(null, lookup)).toBe(UNASSIGNED_LABEL);
    expect(assigneeDisplayName(TEST_MEMBERSHIP_A, lookup)).toBe(
      CURRENT_USER_ASSIGNEE_LABEL,
    );
    expect(assigneeDisplayName(TEST_MEMBERSHIP_B, lookup)).toBe('Jamie');
  });

  it('does not merge ended and rejoin tenures by name', () => {
    expect(assigneeDisplayName(TEST_ENDED_MEMBERSHIP, lookup)).toBe(
      FORMER_ROOMMATE_LABEL,
    );
    expect(assigneeDisplayName(TEST_REJOIN_MEMBERSHIP, lookup)).toBe('Alex');
  });

  it('does not guess names before memberships are ready', () => {
    expect(
      assigneeDisplayName(TEST_MEMBERSHIP_B, {
        ...lookup,
        membershipsReady: false,
        memberships: [],
      }),
    ).toBe(ASSIGNED_FALLBACK_LABEL);
  });

  it('labels picker options without exposing membership IDs', () => {
    expect(
      assigneePickerLabel(
        { membershipId: TEST_MEMBERSHIP_A, name: 'Alex' },
        TEST_MEMBERSHIP_A,
      ),
    ).toBe(CURRENT_USER_ASSIGNEE_LABEL);
    expect(
      assigneePickerLabel(
        { membershipId: TEST_MEMBERSHIP_B, name: 'Jamie' },
        TEST_MEMBERSHIP_A,
      ),
    ).toBe('Jamie');
    expect(
      assigneePickerLabel(
        { membershipId: TEST_MEMBERSHIP_B, name: 'Jamie' },
        TEST_MEMBERSHIP_A,
      ),
    ).not.toContain(TEST_MEMBERSHIP_B);
  });
});
