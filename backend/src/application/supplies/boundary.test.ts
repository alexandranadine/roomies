import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const endingDir = path.join(dir, '../home-administration');

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

void describe('supplies application boundary', () => {
  void it('owns Membership-ending Supply cleanup without Home-administration internals', async () => {
    const cleanup = await readFile(
      path.join(dir, 'membership-ending-supply-cleanup.ts'),
      'utf8',
    );
    const composition = await readFile(
      path.join(endingDir, 'end-membership-within-home-structure.ts'),
      'utf8',
    );
    assert.match(cleanup, /createMembershipEndingSupplyCleanup/);
    assert.match(cleanup, /releaseActiveClaimsForMembership/);
    assert.match(cleanup, /releasedAt: input.endedAt/);
    assert.doesNotMatch(cleanup, /home-administration/);
    assert.doesNotMatch(cleanup, /memberships\/repository/);
    assert.doesNotMatch(cleanup, /homes\/repository/);
    assert.doesNotMatch(cleanup, /from ['"]pg['"]/);
    assert.doesNotMatch(cleanup, /Date\.now/);
    assert.doesNotMatch(cleanup, /new Date\(/);
    assert.doesNotMatch(cleanup, /clock/i);
    assert.doesNotMatch(cleanup, /outbox/);
    assert.doesNotMatch(cleanup, /supply\.claim_released/);
    assert.doesNotMatch(cleanup, /supply\.updated/);
    assert.doesNotMatch(cleanup, /BEGIN/);
    assert.doesNotMatch(cleanup, /COMMIT/);
    assert.doesNotMatch(cleanup, /runInReadCommittedTransaction/);
    assert.doesNotMatch(cleanup, /lockHomeStructure/);
    assert.doesNotMatch(cleanup, /lockHomeAndExactMemberships/);
    assert.doesNotMatch(cleanup, /userId/);
    assert.doesNotMatch(cleanup, /ENTRY_CANCELED/);
    assert.match(composition, /createEndMembershipWithinHomeStructureFromPool/);
    assert.match(composition, /createMembershipEndingSupplyCleanupFromPool/);
    assert.doesNotMatch(
      composition,
      /createTemporaryNoOpMembershipEndingSupplyCleanup/,
    );
    assert.doesNotMatch(composition, /supplies\/repository/);
    assert.doesNotMatch(composition, /FROM\s+supply_claims/i);
    assert.doesNotMatch(composition, /UPDATE\s+supply_claims/i);
  });

  void it('does not import other domain repositories or Express', async () => {
    const files = await walkProduction(dir);
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const rel = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /memberships\/repository/, rel);
      assert.doesNotMatch(source, /homes\/repository/, rel);
      assert.doesNotMatch(source, /tasks\/repository/, rel);
      assert.doesNotMatch(source, /home-administration/, rel);
      assert.doesNotMatch(source, /from ['"]express['"]/, rel);
      assert.doesNotMatch(source, /better-auth/, rel);
      assert.doesNotMatch(source, /from ['"]pg['"]/, rel);
    }
  });
});
