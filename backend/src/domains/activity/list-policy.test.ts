import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ACTIVITY_ACTION } from './actions.js';
import {
  decideActivityList,
  ACTIVITY_LIST_CAPABLE_ROLES,
} from './list-policy.js';

const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const policyPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'list-policy.ts',
);

function actor(
  role: ActiveHomeActor['role'],
  homeId = HOME_A,
): Pick<ActiveHomeActor, 'homeId' | 'role'> {
  return { homeId, role };
}

void describe('decideActivityList', () => {
  void it('names the activity.list action', () => {
    assert.equal(ACTIVITY_ACTION.list, 'activity.list');
  });

  void it('allows Roommate and Admin through the same ordinary capability', () => {
    assert.deepEqual(
      decideActivityList({ actor: actor('ROOMMATE'), targetHomeId: HOME_A }),
      { allowed: true },
    );
    assert.deepEqual(
      decideActivityList({ actor: actor('ADMIN'), targetHomeId: HOME_A }),
      { allowed: true },
    );
    assert.deepEqual([...ACTIVITY_LIST_CAPABLE_ROLES], ['ROOMMATE', 'ADMIN']);
  });

  void it('denies a Home-scope mismatch for both roles', () => {
    assert.deepEqual(
      decideActivityList({ actor: actor('ROOMMATE'), targetHomeId: HOME_B }),
      { allowed: false, reason: 'HOME_SCOPE_MISMATCH' },
    );
    assert.deepEqual(
      decideActivityList({ actor: actor('ADMIN'), targetHomeId: HOME_B }),
      { allowed: false, reason: 'HOME_SCOPE_MISMATCH' },
    );
  });

  void it('has no Admin-bypass special case', async () => {
    const source = await readFile(policyPath, 'utf8');
    assert.doesNotMatch(source, /isHomeAdmin/);
    assert.doesNotMatch(source, /visibilityClass/);
    assert.doesNotMatch(source, /userId/);
    assert.match(source, /ACTIVITY_LIST_CAPABLE_ROLES/);
  });
});
