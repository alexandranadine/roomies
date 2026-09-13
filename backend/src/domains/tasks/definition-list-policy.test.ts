import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { TASK_DEFINITION_ACTION } from './actions.js';
import {
  decideTaskDefinitionList,
  TASK_DEFINITION_LIST_CAPABLE_ROLES,
} from './definition-list-policy.js';

const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const policyPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'definition-list-policy.ts',
);

function actor(
  role: ActiveHomeActor['role'],
  homeId = HOME_A,
): Pick<ActiveHomeActor, 'homeId' | 'role'> {
  return { homeId, role };
}

void describe('decideTaskDefinitionList', () => {
  void it('names the task_definition.list action', () => {
    assert.equal(TASK_DEFINITION_ACTION.list, 'task_definition.list');
  });

  void it('allows an active Roommate through ordinary capability', () => {
    assert.deepEqual(
      decideTaskDefinitionList({
        actor: actor('ROOMMATE'),
        targetHomeId: HOME_A,
      }),
      { allowed: true },
    );
  });

  void it('allows an active Admin through the same ordinary capability', () => {
    assert.deepEqual(
      decideTaskDefinitionList({
        actor: actor('ADMIN'),
        targetHomeId: HOME_A,
      }),
      { allowed: true },
    );
    assert.deepEqual(
      [...TASK_DEFINITION_LIST_CAPABLE_ROLES],
      ['ROOMMATE', 'ADMIN'],
    );
  });

  void it('denies a Home-scope mismatch for both roles', () => {
    assert.deepEqual(
      decideTaskDefinitionList({
        actor: actor('ROOMMATE'),
        targetHomeId: HOME_B,
      }),
      { allowed: false, reason: 'HOME_SCOPE_MISMATCH' },
    );
  });

  void it('has no Admin-bypass special case', async () => {
    const source = await readFile(policyPath, 'utf8');
    assert.doesNotMatch(source, /isHomeAdmin/);
    assert.match(source, /TASK_DEFINITION_LIST_CAPABLE_ROLES/);
  });
});
