import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MembershipRole } from '../../platform/authz/context.js';
import { evaluateHomeStructureInvariant } from '../homes/structure-invariant.js';
import {
  decideMembershipLeave,
  decideMembershipLeaveSelf,
} from './leave-policy.js';

const MEMBERSHIP_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBERSHIP_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const MEMBERSHIP_C = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function memberships(
  ...values: readonly { id: string; role: MembershipRole }[]
): readonly { id: string; role: MembershipRole }[] {
  return values;
}

void describe('decideMembershipLeaveSelf', () => {
  void it('allows only the exact actor Membership id', () => {
    assert.deepEqual(
      decideMembershipLeaveSelf({
        actorMembershipId: MEMBERSHIP_A,
        pathMembershipId: MEMBERSHIP_A,
        lockedActiveMembershipIds: [MEMBERSHIP_A, MEMBERSHIP_B],
      }),
      { allowed: true },
    );
  });

  void it('forbids a different active Membership in the same locked Home', () => {
    assert.deepEqual(
      decideMembershipLeaveSelf({
        actorMembershipId: MEMBERSHIP_A,
        pathMembershipId: MEMBERSHIP_B,
        lockedActiveMembershipIds: [MEMBERSHIP_A, MEMBERSHIP_B],
      }),
      { allowed: false, reason: 'MEMBERSHIP_LEAVE_NOT_SELF' },
    );
  });

  void it('conceals a path id absent from the locked active set', () => {
    assert.deepEqual(
      decideMembershipLeaveSelf({
        actorMembershipId: MEMBERSHIP_A,
        pathMembershipId: MEMBERSHIP_C,
        lockedActiveMembershipIds: [MEMBERSHIP_A, MEMBERSHIP_B],
      }),
      { allowed: false, reason: 'MEMBERSHIP_LEAVE_TARGET_CONCEALED' },
    );
  });
});

void describe('decideMembershipLeave', () => {
  void it('allows a Roommate leave when an Admin remains', () => {
    assert.deepEqual(
      decideMembershipLeave({
        actorMembershipId: MEMBERSHIP_B,
        activeMemberships: memberships(
          { id: MEMBERSHIP_A, role: 'ADMIN' },
          { id: MEMBERSHIP_B, role: 'ROOMMATE' },
        ),
      }),
      { allowed: true },
    );
  });

  void it('allows an Admin leave when another Admin remains', () => {
    assert.deepEqual(
      decideMembershipLeave({
        actorMembershipId: MEMBERSHIP_A,
        activeMemberships: memberships(
          { id: MEMBERSHIP_A, role: 'ADMIN' },
          { id: MEMBERSHIP_B, role: 'ADMIN' },
        ),
      }),
      { allowed: true },
    );
  });

  void it('rejects an Admin leave when only Roommate(s) would remain', () => {
    assert.deepEqual(
      decideMembershipLeave({
        actorMembershipId: MEMBERSHIP_A,
        activeMemberships: memberships(
          { id: MEMBERSHIP_A, role: 'ADMIN' },
          { id: MEMBERSHIP_B, role: 'ROOMMATE' },
        ),
      }),
      { allowed: false, reason: 'LAST_ADMIN_REQUIRED' },
    );
  });

  void it('rejects sole Admin leave with LAST_ROOMMATE_REQUIRES_ARCHIVE', () => {
    assert.deepEqual(
      decideMembershipLeave({
        actorMembershipId: MEMBERSHIP_A,
        activeMemberships: memberships({ id: MEMBERSHIP_A, role: 'ADMIN' }),
      }),
      { allowed: false, reason: 'LAST_ROOMMATE_REQUIRES_ARCHIVE' },
    );
  });

  void it('gives sole-member archive precedence over last-Admin', () => {
    const decision = decideMembershipLeave({
      actorMembershipId: MEMBERSHIP_A,
      activeMemberships: memberships({ id: MEMBERSHIP_A, role: 'ADMIN' }),
    });
    assert.deepEqual(decision, {
      allowed: false,
      reason: 'LAST_ROOMMATE_REQUIRES_ARCHIVE',
    });
    assert.notEqual(
      decision.allowed === false ? decision.reason : undefined,
      'LAST_ADMIN_REQUIRED',
    );
  });

  void it('leaves corrupt sole Roommate to structural integrity before policy', () => {
    assert.deepEqual(
      evaluateHomeStructureInvariant({
        archived: false,
        activeMemberships: [{ role: 'ROOMMATE' }],
      }),
      { ok: false, reason: 'ACTIVE_HOME_WITHOUT_ADMIN' },
    );
  });

  void it('does not mutate roles or propose a replacement Admin', () => {
    const decision = decideMembershipLeave({
      actorMembershipId: MEMBERSHIP_A,
      activeMemberships: memberships(
        { id: MEMBERSHIP_A, role: 'ADMIN' },
        { id: MEMBERSHIP_B, role: 'ROOMMATE' },
      ),
    });
    assert.deepEqual(decision, {
      allowed: false,
      reason: 'LAST_ADMIN_REQUIRED',
    });
    assert.ok(!('repair' in decision));
    assert.ok(!('promotedMembershipId' in decision));
    assert.ok(!('newRole' in decision));
  });
});
