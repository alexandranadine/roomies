import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MembershipRole } from '../../platform/authz/context.js';
import { evaluateHomeStructureInvariant } from '../homes/structure-invariant.js';
import {
  decideMembershipChangeRole,
  decideProposedAdminInvariant,
} from './role-policy.js';

function roles(
  ...values: MembershipRole[]
): readonly { role: MembershipRole }[] {
  return values.map((role) => ({ role }));
}

void describe('decideMembershipChangeRole', () => {
  void it('allows an Admin to promote another Roommate', () => {
    assert.deepEqual(decideMembershipChangeRole({ actorRole: 'ADMIN' }), {
      allowed: true,
    });
  });

  void it('allows an Admin to demote another Admin', () => {
    assert.deepEqual(decideMembershipChangeRole({ actorRole: 'ADMIN' }), {
      allowed: true,
    });
  });

  void it('allows an Admin self-demotion capability check', () => {
    assert.deepEqual(decideMembershipChangeRole({ actorRole: 'ADMIN' }), {
      allowed: true,
    });
  });

  void it('denies a Roommate any role change, including self-promotion', () => {
    assert.deepEqual(decideMembershipChangeRole({ actorRole: 'ROOMMATE' }), {
      allowed: false,
      reason: 'MEMBERSHIP_CHANGE_ROLE_DENIED',
    });
  });

  void it('requires authorization even when the requested role is unchanged', () => {
    assert.deepEqual(decideMembershipChangeRole({ actorRole: 'ROOMMATE' }), {
      allowed: false,
      reason: 'MEMBERSHIP_CHANGE_ROLE_DENIED',
    });
    assert.deepEqual(decideMembershipChangeRole({ actorRole: 'ADMIN' }), {
      allowed: true,
    });
  });
});

void describe('decideProposedAdminInvariant', () => {
  void it('allows promoting a Roommate while an Admin remains', () => {
    assert.deepEqual(
      decideProposedAdminInvariant({
        proposedActiveMemberships: roles('ADMIN', 'ADMIN'),
      }),
      { allowed: true },
    );
  });

  void it('allows demoting an Admin while another Admin remains', () => {
    assert.deepEqual(
      decideProposedAdminInvariant({
        proposedActiveMemberships: roles('ROOMMATE', 'ADMIN'),
      }),
      { allowed: true },
    );
  });

  void it('allows Admin self-demotion while another Admin remains', () => {
    assert.deepEqual(
      decideProposedAdminInvariant({
        proposedActiveMemberships: roles('ROOMMATE', 'ADMIN'),
      }),
      { allowed: true },
    );
  });

  void it('rejects last-Admin self-demotion without repairing the snapshot', () => {
    assert.deepEqual(
      decideProposedAdminInvariant({
        proposedActiveMemberships: roles('ROOMMATE', 'ROOMMATE'),
      }),
      { allowed: false, reason: 'LAST_ADMIN_REQUIRED' },
    );
  });

  void it('rejects demoting the last remaining Admin target', () => {
    assert.deepEqual(
      decideProposedAdminInvariant({
        proposedActiveMemberships: roles('ROOMMATE'),
      }),
      { allowed: false, reason: 'LAST_ADMIN_REQUIRED' },
    );
  });

  void it('does not auto-repair a zero-Admin proposed snapshot', () => {
    const decision = decideProposedAdminInvariant({
      proposedActiveMemberships: roles('ROOMMATE', 'ROOMMATE'),
    });
    assert.deepEqual(decision, {
      allowed: false,
      reason: 'LAST_ADMIN_REQUIRED',
    });
    assert.ok(!('repair' in decision));
    assert.ok(!('promotedMembershipId' in decision));
  });

  void it('leaves an existing zero-Admin snapshot to structural integrity, not repair', () => {
    assert.deepEqual(
      evaluateHomeStructureInvariant({
        archived: false,
        activeMemberships: roles('ROOMMATE', 'ROOMMATE'),
      }),
      { ok: false, reason: 'ACTIVE_HOME_WITHOUT_ADMIN' },
    );
  });
});
