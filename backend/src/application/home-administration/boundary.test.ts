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

void describe('home-administration application boundary', () => {
  void it('coordinates public Home/Membership/outbox surfaces without repository internals', async () => {
    const source = await readFile(
      path.join(dir, 'change-membership-role.ts'),
      'utf8',
    );
    assert.doesNotMatch(source, /memberships\/repository/);
    assert.doesNotMatch(source, /homes\/repository/);
    assert.doesNotMatch(source, /home-repository/);
    assert.doesNotMatch(source, /active-home-actor-lookup/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /SERIALIZABLE/);
    assert.doesNotMatch(source, /pg_advisory/i);
    assert.doesNotMatch(source, /ended_at\s*=/);
    assert.doesNotMatch(source, /user_id\s*=/);
    assert.match(source, /lockHomeStructure/);
    assert.match(source, /decideMembershipChangeRole/);
    assert.match(
      source,
      /membership\.role_changed\.v1|createMembershipRoleChangedV1Event/,
    );
  });

  void it('keeps membership ending on public ports without owning the transaction', async () => {
    const source = await readFile(
      path.join(dir, 'end-membership-within-home-structure.ts'),
      'utf8',
    );
    assert.doesNotMatch(source, /memberships\/repository/);
    assert.doesNotMatch(source, /homes\/repository/);
    assert.doesNotMatch(source, /home-repository/);
    assert.doesNotMatch(source, /active-home-actor-lookup/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /better-auth/);
    assert.doesNotMatch(source, /BEGIN/);
    assert.doesNotMatch(source, /COMMIT/);
    assert.doesNotMatch(source, /ROLLBACK/);
    assert.doesNotMatch(source, /pool\.connect/);
    assert.doesNotMatch(source, /runInReadCommittedTransaction/);
    assert.doesNotMatch(source, /Date\.now/);
    assert.doesNotMatch(source, /canEndMembership/);
    assert.doesNotMatch(source, /ended_at\s*=/);
    assert.doesNotMatch(source, /user_id/);
    assert.doesNotMatch(source, /lockHomeStructure/);
    assert.doesNotMatch(source, /ForbiddenError/);
    assert.match(source, /handleMembershipEnded/);
    assert.match(source, /createMembershipEndedV1Event/);
    assert.match(source, /createTemporaryNoOpMembershipEndingTaskCleanup/);
    assert.match(source, /createTemporaryNoOpMembershipEndingSupplyCleanup/);
  });

  void it('makes temporary Task/Supply no-op replacement obligatory and explicit', async () => {
    const composition = await readFile(
      path.join(dir, 'end-membership-within-home-structure.ts'),
      'utf8',
    );
    assert.match(
      composition,
      /createEndMembershipWithinHomeStructureWithTemporaryNoOpCleanup/,
    );
    assert.match(composition, /MUST be replaced when M3 Tasks \/ M4 Supplies/);
    assert.doesNotMatch(composition, /taskCleanup\?:/);
    assert.doesNotMatch(composition, /supplyCleanup\?:/);

    const files = await walkProduction(dir);
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const rel = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /memberships\/repository/, rel);
      assert.doesNotMatch(source, /homes\/repository/, rel);
      assert.doesNotMatch(source, /from ['"]express['"]/, rel);
      assert.doesNotMatch(source, /better-auth/, rel);
      assert.doesNotMatch(source, /from ['"]pg['"]/, rel);
    }
  });
});
