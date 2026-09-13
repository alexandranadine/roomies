import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { MEMBERSHIP_ACTION } from './actions.js';
import {
  decideMembershipListActive,
  MEMBERSHIP_LIST_ACTIVE_CAPABLE_ROLES,
} from './list-active-policy.js';

const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const policyPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'list-active-policy.ts',
);

function actor(
  role: ActiveHomeActor['role'],
  homeId = HOME_A,
): Pick<ActiveHomeActor, 'homeId' | 'role'> {
  return { homeId, role };
}

void describe('decideMembershipListActive', () => {
  void it('names the membership.list_active action', () => {
    assert.equal(MEMBERSHIP_ACTION.listActive, 'membership.list_active');
  });

  void it('allows an active Roommate through ordinary capability', () => {
    assert.deepEqual(
      decideMembershipListActive({
        actor: actor('ROOMMATE'),
        targetHomeId: HOME_A,
      }),
      { allowed: true },
    );
  });

  void it('allows an active Admin through the same ordinary capability', () => {
    assert.deepEqual(
      decideMembershipListActive({
        actor: actor('ADMIN'),
        targetHomeId: HOME_A,
      }),
      { allowed: true },
    );
    assert.deepEqual(
      [...MEMBERSHIP_LIST_ACTIVE_CAPABLE_ROLES],
      ['ROOMMATE', 'ADMIN'],
    );
  });

  void it('denies a Home-scope mismatch for both roles', () => {
    assert.deepEqual(
      decideMembershipListActive({
        actor: actor('ROOMMATE'),
        targetHomeId: HOME_B,
      }),
      { allowed: false, reason: 'HOME_SCOPE_MISMATCH' },
    );
    assert.deepEqual(
      decideMembershipListActive({
        actor: actor('ADMIN'),
        targetHomeId: HOME_B,
      }),
      { allowed: false, reason: 'HOME_SCOPE_MISMATCH' },
    );
  });

  void it('does not grant membership.list_active to an inactive Membership', () => {
    assert.equal(
      (MEMBERSHIP_LIST_ACTIVE_CAPABLE_ROLES as readonly string[]).includes(
        'INACTIVE',
      ),
      false,
    );
  });

  void it('has no Admin-bypass special case', async () => {
    const source = await readFile(policyPath, 'utf8');
    assert.doesNotMatch(
      source,
      /if\s*\(\s*actor\.role\s*===\s*['"]ADMIN['"]\s*\)\s*return\s+allow\s*\(/,
    );
    assert.doesNotMatch(source, /isHomeAdmin/);
    assert.doesNotMatch(source, /structural-owner/);
    assert.match(source, /MEMBERSHIP_LIST_ACTIVE_CAPABLE_ROLES/);
  });
});
