import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { MAINTENANCE_ACTION } from './actions.js';
import {
  decideMaintenanceResolve,
  MAINTENANCE_RESOLVE_CAPABLE_ROLES,
} from './resolve-policy.js';

const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const policyPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'resolve-policy.ts',
);

function actor(
  role: ActiveHomeActor['role'],
  homeId = HOME_A,
): Pick<ActiveHomeActor, 'homeId' | 'role'> {
  return { homeId, role };
}

void describe('decideMaintenanceResolve', () => {
  void it('names the maintenance.resolve action', () => {
    assert.equal(MAINTENANCE_ACTION.resolve, 'maintenance.resolve');
  });

  void it('allows Roommate and Admin through the same ordinary capability', () => {
    assert.deepEqual(
      decideMaintenanceResolve({
        actor: actor('ROOMMATE'),
        targetHomeId: HOME_A,
      }),
      { allowed: true },
    );
    assert.deepEqual(
      decideMaintenanceResolve({ actor: actor('ADMIN'), targetHomeId: HOME_A }),
      { allowed: true },
    );
    assert.deepEqual(
      [...MAINTENANCE_RESOLVE_CAPABLE_ROLES],
      ['ROOMMATE', 'ADMIN'],
    );
  });

  void it('denies a Home-scope mismatch for both roles', () => {
    assert.deepEqual(
      decideMaintenanceResolve({
        actor: actor('ROOMMATE'),
        targetHomeId: HOME_B,
      }),
      { allowed: false, reason: 'HOME_SCOPE_MISMATCH' },
    );
    assert.deepEqual(
      decideMaintenanceResolve({ actor: actor('ADMIN'), targetHomeId: HOME_B }),
      { allowed: false, reason: 'HOME_SCOPE_MISMATCH' },
    );
  });

  void it('has no Admin-bypass or creator-only special case', async () => {
    const source = await readFile(policyPath, 'utf8');
    assert.doesNotMatch(source, /isHomeAdmin/);
    assert.doesNotMatch(source, /createdBy/);
    assert.doesNotMatch(source, /created_by_membership_id/);
    assert.match(source, /MAINTENANCE_RESOLVE_CAPABLE_ROLES/);
  });
});
