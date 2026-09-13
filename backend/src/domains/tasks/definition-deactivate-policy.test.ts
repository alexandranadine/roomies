import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { TASK_DEFINITION_ACTION } from './actions.js';
import { decideTaskDefinitionDeactivate } from './definition-deactivate-policy.js';

const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CREATOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const policyPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'definition-deactivate-policy.ts',
);

function actor(
  role: ActiveHomeActor['role'],
  membershipId: string,
  homeId = HOME_A,
): Pick<ActiveHomeActor, 'homeId' | 'membershipId' | 'role'> {
  return { homeId, membershipId, role };
}

void describe('decideTaskDefinitionDeactivate', () => {
  void it('names the task_definition.deactivate action', () => {
    assert.equal(
      TASK_DEFINITION_ACTION.deactivate,
      'task_definition.deactivate',
    );
  });

  void it('allows the exact creator Roommate', () => {
    assert.deepEqual(
      decideTaskDefinitionDeactivate({
        actor: actor('ROOMMATE', CREATOR),
        targetHomeId: HOME_A,
        creatorMembershipId: CREATOR,
      }),
      { allowed: true },
    );
  });

  void it('allows a non-creator Admin through locked Admin authority', () => {
    assert.deepEqual(
      decideTaskDefinitionDeactivate({
        actor: actor('ADMIN', OTHER),
        targetHomeId: HOME_A,
        creatorMembershipId: CREATOR,
      }),
      { allowed: true },
    );
  });

  void it('denies a non-creator Roommate', () => {
    assert.deepEqual(
      decideTaskDefinitionDeactivate({
        actor: actor('ROOMMATE', OTHER),
        targetHomeId: HOME_A,
        creatorMembershipId: CREATOR,
      }),
      { allowed: false, reason: 'TASK_DEFINITION_DEACTIVATE_DENIED' },
    );
  });

  void it('denies a Home-scope mismatch even for the creator', () => {
    assert.deepEqual(
      decideTaskDefinitionDeactivate({
        actor: actor('ROOMMATE', CREATOR, HOME_B),
        targetHomeId: HOME_A,
        creatorMembershipId: CREATOR,
      }),
      { allowed: false, reason: 'HOME_SCOPE_MISMATCH' },
    );
  });

  void it('does not treat assignee identity or userId as creator authority', async () => {
    const source = await readFile(policyPath, 'utf8');
    assert.doesNotMatch(source, /isHomeAdmin/);
    assert.doesNotMatch(source, /actor\.userId/);
    assert.doesNotMatch(source, /assignedMembershipId/);
    assert.match(source, /creatorMembershipId/);
  });
});
