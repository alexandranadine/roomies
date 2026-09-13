import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { MAINTENANCE_ACTION } from './actions.js';
import {
  decideMaintenanceRead,
  MAINTENANCE_READ_CAPABLE_ROLES,
} from './read-policy.js';

const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const policyPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'read-policy.ts',
);

function actor(
  role: ActiveHomeActor['role'],
  homeId = HOME_A,
): Pick<ActiveHomeActor, 'homeId' | 'role'> {
  return { homeId, role };
}

void describe('decideMaintenanceRead', () => {
  void it('names the maintenance.read action', () => {
    assert.equal(MAINTENANCE_ACTION.read, 'maintenance.read');
  });

  void it('allows Roommate and Admin through the same ordinary capability', () => {
    assert.deepEqual(
      decideMaintenanceRead({ actor: actor('ROOMMATE'), targetHomeId: HOME_A }),
      { allowed: true },
    );
    assert.deepEqual(
      decideMaintenanceRead({ actor: actor('ADMIN'), targetHomeId: HOME_A }),
      { allowed: true },
    );
    assert.deepEqual(
      [...MAINTENANCE_READ_CAPABLE_ROLES],
      ['ROOMMATE', 'ADMIN'],
    );
  });

  void it('denies a Home-scope mismatch for both roles', () => {
    assert.deepEqual(
      decideMaintenanceRead({ actor: actor('ROOMMATE'), targetHomeId: HOME_B }),
      { allowed: false, reason: 'HOME_SCOPE_MISMATCH' },
    );
    assert.deepEqual(
      decideMaintenanceRead({ actor: actor('ADMIN'), targetHomeId: HOME_B }),
      { allowed: false, reason: 'HOME_SCOPE_MISMATCH' },
    );
  });

  void it('has no Admin-bypass special case', async () => {
    const source = await readFile(policyPath, 'utf8');
    assert.doesNotMatch(source, /isHomeAdmin/);
    assert.doesNotMatch(source, /createdBy/);
    assert.match(source, /MAINTENANCE_READ_CAPABLE_ROLES/);
  });
});
