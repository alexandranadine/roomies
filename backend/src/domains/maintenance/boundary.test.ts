import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const maintenanceDir = path.dirname(fileURLToPath(import.meta.url));

async function productionFiles(): Promise<readonly string[]> {
  const entries = await readdir(maintenanceDir, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts'),
    )
    .map((entry) => path.join(maintenanceDir, entry.name));
}

void describe('maintenance domain boundary', () => {
  void it('does not import other domain repositories or sibling internals', async () => {
    for (const file of await productionFiles()) {
      const source = await readFile(file, 'utf8');
      const relative = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /domains\/homes\/repository/, relative);
      assert.doesNotMatch(source, /memberships\/repository/, relative);
      assert.doesNotMatch(source, /domains\/tasks/, relative);
      assert.doesNotMatch(source, /domains\/supplies/, relative);
      assert.doesNotMatch(source, /home-administration/, relative);
      assert.doesNotMatch(source, /platform\/runtime/, relative);
      assert.doesNotMatch(source, /outbox/, relative);
      assert.doesNotMatch(source, /better-auth/, relative);
      assert.doesNotMatch(source, /user_id/, relative);
      if (!relative.endsWith('/http.ts')) {
        assert.doesNotMatch(source, /from ['"]express['"]/, relative);
      }
    }
  });

  void it('owns persistence primitives without independent audience writes', async () => {
    const source = await readFile(
      path.join(maintenanceDir, 'repository.ts'),
      'utf8',
    );
    for (const primitive of [
      'insertEntryWithAudience',
      'findVisibleByHomeAndId',
      'lockVisibleForResolve',
      'listVisibleByHome',
      'resolveOpenEntry',
    ]) {
      assert.match(source, new RegExp(primitive));
    }
    assert.match(source, /MAINTENANCE_ACTOR_SCOPE_SQL/);
    assert.match(source, /MAINTENANCE_VISIBLE_PREDICATE_SQL/);
    assert.match(source, /INSERT_MAINTENANCE_AUDIENCE_SET_SQL/);
    assert.match(source, /ORDER BY u\.membership_id ASC/);
    assert.match(source, /FOR UPDATE OF e/);
    assert.match(source, /status = 'OPEN'/);
    assert.match(source, /resolved_by_membership_id IS NULL/);
    assert.doesNotMatch(source, /export async function insertAudience/);
    assert.doesNotMatch(source, /addAudience|updateAudience|deleteAudience/);
    assert.doesNotMatch(source, /INSERT_MAINTENANCE_AUDIENCE_SQL =/);
    assert.doesNotMatch(source, /findById\(/);
    assert.doesNotMatch(source, /DELETE /i);
    assert.doesNotMatch(source, /reopen/i);
    assert.doesNotMatch(source, /console\.log/);
    assert.doesNotMatch(source, /maintenance\.created/);
    assert.doesNotMatch(source, /outbox/);
  });

  void it('keeps title and details free of persistence, HTTP, and JS Date', async () => {
    for (const name of ['maintenance-title.ts', 'maintenance-details.ts']) {
      const source = await readFile(path.join(maintenanceDir, name), 'utf8');
      assert.doesNotMatch(source, /from ['"]pg['"]/);
      assert.doesNotMatch(source, /from ['"]express['"]/);
      assert.doesNotMatch(source, /new Date\(/);
      assert.doesNotMatch(source, /Date\.UTC/);
      assert.doesNotMatch(source, /toISOString/);
    }
    const title = await readFile(
      path.join(maintenanceDir, 'maintenance-title.ts'),
      'utf8',
    );
    const details = await readFile(
      path.join(maintenanceDir, 'maintenance-details.ts'),
      'utf8',
    );
    assert.match(title, /MAINTENANCE_TITLE_MAX_LENGTH = 120/);
    assert.match(details, /MAINTENANCE_DETAILS_MAX_LENGTH = 4000/);
  });

  void it('keeps Maintenance policies free of Home-read authz and Admin bypass', async () => {
    for (const name of [
      'create-policy.ts',
      'list-policy.ts',
      'read-policy.ts',
      'resolve-policy.ts',
      'actions.ts',
    ]) {
      const source = await readFile(path.join(maintenanceDir, name), 'utf8');
      assert.doesNotMatch(source, /decideHomeRead/);
      assert.doesNotMatch(source, /isHomeAdmin/);
      assert.doesNotMatch(source, /from ['"]pg['"]/);
      assert.doesNotMatch(source, /from ['"]express['"]/);
      assert.doesNotMatch(source, /FOR UPDATE/i);
      assert.doesNotMatch(source, /actor\.userId|input\.userId/);
    }
    const actions = await readFile(
      path.join(maintenanceDir, 'actions.ts'),
      'utf8',
    );
    assert.match(actions, /maintenance\.create/);
    assert.match(actions, /maintenance\.list/);
    assert.match(actions, /maintenance\.read/);
    assert.match(actions, /maintenance\.resolve/);
    assert.doesNotMatch(actions, /maintenance\.create_private/);
    assert.doesNotMatch(actions, /maintenance\.reopen/);
    assert.doesNotMatch(actions, /maintenance\.delete/);
    assert.doesNotMatch(actions, /audience/);
  });

  void it('keeps Maintenance HTTP adapter-only on the existing Home authz path', async () => {
    const source = await readFile(path.join(maintenanceDir, 'http.ts'), 'utf8');
    assert.match(source, /router\.post\('\/:homeId\/maintenance'/);
    assert.match(source, /createRequireHomeContext/);
    assert.match(source, /createRequireAuth/);
    assert.match(source, /setPrivateNoStoreHeaders/);
    assert.match(source, /discriminatedUnion\('visibility'/);
    assert.match(source, /\.strict\(\)/);
    assert.match(source, /toMaintenanceDetailDto/);
    assert.doesNotMatch(source, /lockHomeAndExactMemberships/);
    assert.doesNotMatch(source, /findActiveExactMembershipIdsInHome/);
    assert.doesNotMatch(source, /FROM\s+maintenance_entries/i);
    assert.doesNotMatch(source, /FROM\s+memberships/i);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /better-auth/);
    assert.doesNotMatch(source, /maintenance\.created/);
    assert.doesNotMatch(source, /outbox/);
    assert.doesNotMatch(source, /router\.get/i);
    assert.doesNotMatch(source, /router\.patch/i);
    assert.doesNotMatch(source, /router\.delete/i);
    assert.doesNotMatch(source, /audienceMembershipIds.*res\.json/);
  });
});
