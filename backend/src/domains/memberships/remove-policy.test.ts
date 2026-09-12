import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MembershipRole } from '../../platform/authz/context.js';
import { evaluateHomeStructureInvariant } from '../homes/structure-invariant.js';
import {
  decideMembershipRemove,
  decideMembershipRemoveProposed,
  decideMembershipRemoveSelf,
  decideMembershipRemoveTarget,
} from './remove-policy.js';

const MEMBERSHIP_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBERSHIP_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const MEMBERSHIP_C = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function memberships(
  ...values: readonly { id: string; role: MembershipRole }[]
): readonly { id: string; role: MembershipRole }[] {
  return values;
}

void describe('decideMembershipRemove', () => {
  void it('allows an Admin to remove another Roommate', () => {
    assert.deepEqual(decideMembershipRemove({ actorRole: 'ADMIN' }), {
      allowed: true,
    });
  });

  void it('allows an Admin to remove another Admin when capability is checked', () => {
    assert.deepEqual(decideMembershipRemove({ actorRole: 'ADMIN' }), {
      allowed: true,
    });
  });

  void it('denies a Roommate any remove, including a visible Admin target', () => {
    assert.deepEqual(decideMembershipRemove({ actorRole: 'ROOMMATE' }), {
      allowed: false,
      reason: 'MEMBERSHIP_REMOVE_DENIED',
    });
  });
});

void describe('decideMembershipRemoveTarget', () => {
  void it('requires the exact path Membership id in the locked active set', () => {
    assert.deepEqual(
      decideMembershipRemoveTarget({
        pathMembershipId: MEMBERSHIP_B,
        lockedActiveMembershipIds: [MEMBERSHIP_A, MEMBERSHIP_B],
      }),
      { allowed: true },
    );
  });

  void it('conceals a path id absent from the locked active set', () => {
    assert.deepEqual(
      decideMembershipRemoveTarget({
        pathMembershipId: MEMBERSHIP_C,
        lockedActiveMembershipIds: [MEMBERSHIP_A, MEMBERSHIP_B],
      }),
      { allowed: false, reason: 'MEMBERSHIP_REMOVE_TARGET_CONCEALED' },
    );
  });
});

void describe('decideMembershipRemoveSelf', () => {
  void it('forbids remove against the actor exact Membership id', () => {
    assert.deepEqual(
      decideMembershipRemoveSelf({
        actorMembershipId: MEMBERSHIP_A,
        pathMembershipId: MEMBERSHIP_A,
      }),
      { allowed: false, reason: 'MEMBERSHIP_REMOVE_SELF' },
    );
  });

  void it('allows remove against a different Membership id', () => {
    assert.deepEqual(
      decideMembershipRemoveSelf({
        actorMembershipId: MEMBERSHIP_A,
        pathMembershipId: MEMBERSHIP_B,
      }),
      { allowed: true },
    );
  });
});

void describe('decideMembershipRemoveProposed', () => {
  void it('allows an Admin to remove a Roommate when an Admin remains', () => {
    assert.deepEqual(
      decideMembershipRemoveProposed({
        targetMembershipId: MEMBERSHIP_B,
        activeMemberships: memberships(
          { id: MEMBERSHIP_A, role: 'ADMIN' },
          { id: MEMBERSHIP_B, role: 'ROOMMATE' },
        ),
      }),
      { allowed: true },
    );
  });

  void it('allows an Admin to remove another Admin when an Admin remains', () => {
    assert.deepEqual(
      decideMembershipRemoveProposed({
        targetMembershipId: MEMBERSHIP_B,
        activeMemberships: memberships(
          { id: MEMBERSHIP_A, role: 'ADMIN' },
          { id: MEMBERSHIP_B, role: 'ADMIN' },
        ),
      }),
      { allowed: true },
    );
  });

  void it('rejects a proposed zero-Admin remaining set', () => {
    assert.deepEqual(
      decideMembershipRemoveProposed({
        targetMembershipId: MEMBERSHIP_A,
        activeMemberships: memberships(
          { id: MEMBERSHIP_A, role: 'ADMIN' },
          { id: MEMBERSHIP_B, role: 'ROOMMATE' },
        ),
      }),
      { allowed: false, reason: 'LAST_ADMIN_REQUIRED' },
    );
  });

  void it('does not archive or repair a proposed zero-Admin snapshot', () => {
    const decision = decideMembershipRemoveProposed({
      targetMembershipId: MEMBERSHIP_A,
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
    assert.ok(!('archive' in decision));
    assert.notEqual(
      decision.allowed === false ? decision.reason : undefined,
      'LAST_ROOMMATE_REQUIRES_ARCHIVE',
    );
  });

  void it('leaves a current zero-Admin snapshot to structural integrity before policy', () => {
    assert.deepEqual(
      evaluateHomeStructureInvariant({
        archived: false,
        activeMemberships: [{ role: 'ROOMMATE' }, { role: 'ROOMMATE' }],
      }),
      { ok: false, reason: 'ACTIVE_HOME_WITHOUT_ADMIN' },
    );
  });
});
