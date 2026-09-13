import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const suppliesDir = path.dirname(fileURLToPath(import.meta.url));

async function productionFiles(): Promise<readonly string[]> {
  const entries = await readdir(suppliesDir, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts'),
    )
    .map((entry) => path.join(suppliesDir, entry.name));
}

void describe('supplies domain boundary', () => {
  void it('does not import other domain repositories or runtime adapters', async () => {
    for (const file of await productionFiles()) {
      const source = await readFile(file, 'utf8');
      const relative = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /domains\/homes\/repository/, relative);
      assert.doesNotMatch(source, /memberships\/repository/, relative);
      assert.doesNotMatch(source, /domains\/tasks/, relative);
      assert.doesNotMatch(source, /home-administration/, relative);
      assert.doesNotMatch(source, /from ['"]express['"]/, relative);
      assert.doesNotMatch(source, /platform\/runtime/, relative);
      assert.doesNotMatch(source, /outbox/, relative);
      assert.doesNotMatch(source, /user_id/, relative);
    }
  });

  void it('keeps repository primitives Home-scoped and persistence-only', async () => {
    const source = await readFile(
      path.join(suppliesDir, 'repository.ts'),
      'utf8',
    );
    for (const primitive of [
      'insertSupplyEntry',
      'insertSupplyClaim',
      'findActiveClaimByEntry',
      'listClaimsForEntry',
      'listOpenEntriesByHome',
      'releaseActiveClaimsForMembership',
    ]) {
      assert.match(source, new RegExp(primitive));
    }
    assert.match(source, /RELEASE_ACTIVE_CLAIMS_FOR_MEMBERSHIP_SQL/);
    assert.match(source, /claimant_membership_id = \$2::uuid/);
    assert.match(source, /release_reason = 'MEMBERSHIP_ENDED'/);
    assert.match(source, /home_id = \$1::uuid/);
    assert.match(source, /released_at IS NULL/);
    assert.match(source, /ORDER BY claimed_at ASC, id ASC/);
    assert.match(source, /ORDER BY created_at ASC, id ASC/);
    assert.doesNotMatch(source, /DELETE /i);
    assert.doesNotMatch(source, /claimed_by_membership_id/);
    assert.doesNotMatch(source, /quantity|price|reimbursement/i);
  });
});
