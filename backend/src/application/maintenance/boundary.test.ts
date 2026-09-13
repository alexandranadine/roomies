import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

async function walkProduction(root: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkProduction(full)));
      continue;
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

void describe('maintenance application boundary', () => {
  void it('creates Maintenance through public lock, validation, and insert seams', async () => {
    const source = await readFile(
      path.join(dir, 'create-maintenance-entry.ts'),
      'utf8',
    );
    assert.match(source, /decideMaintenanceCreate/);
    assert.match(source, /lockHomeAndExactMemberships/);
    assert.match(source, /findActiveExactMembershipIdsInHome/);
    assert.match(source, /insertEntryWithAudience/);
    assert.match(source, /runInReadCommittedTransaction/);
    assert.match(source, /normalizeMaintenanceTitle/);
    assert.match(source, /normalizeMaintenanceDetails/);
    assert.match(source, /createdByMembershipId: actor\.membershipId/);
    assert.match(source, /status: 'OPEN'/);
    assert.match(
      source,
      /membershipIds: Object\.freeze\(\[input\.actor\.membershipId\]\)/,
    );
    assert.match(source, /userId/);
    assert.doesNotMatch(source, /decideHomeRead/);
    assert.doesNotMatch(source, /findActiveHomeMembership/);
    assert.doesNotMatch(source, /memberships\/repository/);
    assert.doesNotMatch(source, /homes\/repository/);
    assert.doesNotMatch(source, /home-repository/);
    assert.doesNotMatch(source, /active-home-actor-lookup/);
    assert.doesNotMatch(source, /lockHomeStructure/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /better-auth/);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /Date\.now/);
    assert.doesNotMatch(source, /new Date\(/);
    assert.doesNotMatch(source, /outbox/);
    assert.doesNotMatch(source, /maintenance\.created/);
    assert.doesNotMatch(source, /SERIALIZABLE/);
    assert.doesNotMatch(source, /pg_advisory/i);
    assert.doesNotMatch(source, /user_id/);
    assert.doesNotMatch(source, /create_private/);
    assert.doesNotMatch(source, /isHomeAdmin/);
    assert.doesNotMatch(source, /insertAudience|addAudience|updateAudience/);
    assert.doesNotMatch(source, /router\./);
    assert.doesNotMatch(source, /createMaintenanceRouter/);
  });

  void it('does not import repository internals, Express, or sibling writers', async () => {
    const files = await walkProduction(dir);
    assert.ok(files.length > 0);
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const rel = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /memberships\/repository/, rel);
      assert.doesNotMatch(source, /homes\/repository/, rel);
      assert.doesNotMatch(source, /supplies\/repository/, rel);
      assert.doesNotMatch(source, /tasks\/repository/, rel);
      assert.doesNotMatch(source, /home-administration/, rel);
      assert.doesNotMatch(source, /from ['"]express['"]/, rel);
      assert.doesNotMatch(source, /better-auth/, rel);
      assert.doesNotMatch(source, /from ['"]pg['"]/, rel);
    }
  });

  void it('does not create HTTP, resolve, or frontend surfaces in this slice', async () => {
    const names = (await readdir(dir)).filter((name) => name.endsWith('.ts'));
    assert.equal(names.includes('http.ts'), false);
    assert.equal(names.includes('resolve-maintenance-entry.ts'), false);
    const source = await readFile(
      path.join(dir, 'create-maintenance-entry.ts'),
      'utf8',
    );
    assert.doesNotMatch(source, /POST \/maintenance/);
    assert.doesNotMatch(source, /z\.object/);
    assert.doesNotMatch(source, /maintenance\.list/);
    assert.doesNotMatch(source, /maintenance\.read/);
    assert.doesNotMatch(source, /maintenance\.resolve/);
  });

  void it('lists and reads through public repository visibility without app filtering', async () => {
    const list = await readFile(
      path.join(dir, 'list-home-maintenance.ts'),
      'utf8',
    );
    const read = await readFile(
      path.join(dir, 'read-maintenance-entry.ts'),
      'utf8',
    );
    assert.match(list, /decideMaintenanceList/);
    assert.match(list, /listVisibleByHome/);
    assert.match(list, /actorMembershipId: input\.actor\.membershipId/);
    assert.match(list, /MAINTENANCE_LIST_DEFAULT_LIMIT/);
    assert.match(list, /page === null/);
    assert.match(list, /ConcealedNotFoundError/);
    assert.doesNotMatch(list, /filter\(/);
    assert.doesNotMatch(list, /sort\(/);
    assert.doesNotMatch(list, /decodeMaintenanceListCursor/);
    assert.doesNotMatch(list, /bindMaintenanceListCursor/);
    assert.doesNotMatch(list, /userId/);
    assert.doesNotMatch(list, /isHomeAdmin/);
    assert.doesNotMatch(list, /lockHomeAndExactMemberships/);
    assert.doesNotMatch(list, /FOR UPDATE/i);
    assert.doesNotMatch(list, /from ['"]express['"]/);
    assert.doesNotMatch(list, /from ['"]pg['"]/);
    assert.doesNotMatch(list, /outbox/);
    assert.match(read, /decideMaintenanceRead/);
    assert.match(read, /findVisibleByHomeAndId/);
    assert.match(read, /input\.actor\.membershipId/);
    assert.match(read, /ConcealedNotFoundError/);
    assert.doesNotMatch(read, /lockVisibleForResolve/);
    assert.doesNotMatch(read, /userId/);
    assert.doesNotMatch(read, /isHomeAdmin/);
    assert.doesNotMatch(read, /from ['"]express['"]/);
    assert.doesNotMatch(read, /from ['"]pg['"]/);
    assert.doesNotMatch(read, /outbox/);
    assert.doesNotMatch(read, /maintenance\.read_private/);
  });
});
