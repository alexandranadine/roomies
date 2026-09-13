import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { MAINTENANCE_ACTION } from './actions.js';
import {
  decideMaintenanceList,
  MAINTENANCE_LIST_CAPABLE_ROLES,
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

void describe('decideMaintenanceList', () => {
  void it('names the maintenance.list action', () => {
    assert.equal(MAINTENANCE_ACTION.list, 'maintenance.list');
  });

  void it('allows Roommate and Admin through the same ordinary capability', () => {
    assert.deepEqual(
      decideMaintenanceList({ actor: actor('ROOMMATE'), targetHomeId: HOME_A }),
      { allowed: true },
    );
    assert.deepEqual(
      decideMaintenanceList({ actor: actor('ADMIN'), targetHomeId: HOME_A }),
      { allowed: true },
    );
    assert.deepEqual(
      [...MAINTENANCE_LIST_CAPABLE_ROLES],
      ['ROOMMATE', 'ADMIN'],
    );
  });

  void it('denies a Home-scope mismatch for both roles', () => {
    assert.deepEqual(
      decideMaintenanceList({ actor: actor('ROOMMATE'), targetHomeId: HOME_B }),
      { allowed: false, reason: 'HOME_SCOPE_MISMATCH' },
    );
    assert.deepEqual(
      decideMaintenanceList({ actor: actor('ADMIN'), targetHomeId: HOME_B }),
      { allowed: false, reason: 'HOME_SCOPE_MISMATCH' },
    );
  });

  void it('has no Admin-bypass special case', async () => {
    const source = await readFile(policyPath, 'utf8');
    assert.doesNotMatch(source, /isHomeAdmin/);
    assert.doesNotMatch(source, /PRIVATE/);
    assert.match(source, /MAINTENANCE_LIST_CAPABLE_ROLES/);
  });
});
