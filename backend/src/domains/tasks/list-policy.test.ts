import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { TASK_ACTION } from './actions.js';
import { decideTaskList, TASK_LIST_CAPABLE_ROLES } from './list-policy.js';

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

void describe('decideTaskList', () => {
  void it('names the task.list action', () => {
    assert.equal(TASK_ACTION.list, 'task.list');
  });

  void it('allows an active Roommate through ordinary capability', () => {
    assert.deepEqual(
      decideTaskList({ actor: actor('ROOMMATE'), targetHomeId: HOME_A }),
      { allowed: true },
    );
  });

  void it('allows an active Admin through the same ordinary capability', () => {
    assert.deepEqual(
      decideTaskList({ actor: actor('ADMIN'), targetHomeId: HOME_A }),
      { allowed: true },
    );
    assert.deepEqual([...TASK_LIST_CAPABLE_ROLES], ['ROOMMATE', 'ADMIN']);
  });

  void it('denies a Home-scope mismatch for both roles', () => {
    assert.deepEqual(
      decideTaskList({ actor: actor('ROOMMATE'), targetHomeId: HOME_B }),
      { allowed: false, reason: 'HOME_SCOPE_MISMATCH' },
    );
    assert.deepEqual(
      decideTaskList({ actor: actor('ADMIN'), targetHomeId: HOME_B }),
      { allowed: false, reason: 'HOME_SCOPE_MISMATCH' },
    );
  });

  void it('does not grant task.list to an inactive Membership', () => {
    assert.equal(
      (TASK_LIST_CAPABLE_ROLES as readonly string[]).includes('INACTIVE'),
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
    assert.match(source, /TASK_LIST_CAPABLE_ROLES/);
  });
});
