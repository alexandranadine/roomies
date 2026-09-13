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
  void it('does not import other domain repositories or sibling internals', async () => {
    for (const file of await productionFiles()) {
      const source = await readFile(file, 'utf8');
      const relative = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /domains\/homes\/repository/, relative);
      assert.doesNotMatch(source, /memberships\/repository/, relative);
      assert.doesNotMatch(source, /domains\/tasks/, relative);
      assert.doesNotMatch(source, /home-administration/, relative);
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
      'listSupplyEntriesByHome',
      'listSupplyEntriesByHomeAndStatus',
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
    assert.match(source, /LIST_SUPPLY_ENTRIES_BY_HOME_SQL/);
    assert.match(source, /LIST_SUPPLY_ENTRIES_BY_HOME_AND_STATUS_SQL/);
    assert.doesNotMatch(source, /DELETE /i);
    assert.doesNotMatch(source, /claimed_by_membership_id/);
    assert.doesNotMatch(source, /quantity|price|reimbursement/i);
    assert.doesNotMatch(source, /supply_claims[\s\S]*JOIN/i);
    assert.doesNotMatch(source, /JOIN\s+supply_claims/i);
  });

  void it('keeps title rules free of persistence, HTTP, and JS Date', async () => {
    const source = await readFile(
      path.join(suppliesDir, 'supply-title.ts'),
      'utf8',
    );
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /new Date\(/);
    assert.doesNotMatch(source, /Date\.UTC/);
    assert.doesNotMatch(source, /toISOString/);
    assert.match(source, /SUPPLY_TITLE_MAX_LENGTH = 120/);
  });

  void it('keeps Supply policies free of Home-read authz and Admin bypass', async () => {
    for (const name of ['create-policy.ts', 'list-policy.ts', 'actions.ts']) {
      const source = await readFile(path.join(suppliesDir, name), 'utf8');
      assert.doesNotMatch(source, /decideHomeRead/);
      assert.doesNotMatch(source, /isHomeAdmin/);
      assert.doesNotMatch(source, /from ['"]pg['"]/);
      assert.doesNotMatch(source, /from ['"]express['"]/);
      assert.doesNotMatch(source, /FOR UPDATE/i);
    }
    const actions = await readFile(
      path.join(suppliesDir, 'actions.ts'),
      'utf8',
    );
    assert.match(actions, /supply\.create/);
    assert.match(actions, /supply\.list/);
    assert.doesNotMatch(actions, /supply\.claim/);
    assert.doesNotMatch(actions, /supply\.obtain/);
    assert.doesNotMatch(actions, /supply\.cancel/);
  });

  void it('keeps Supply HTTP adapter-only on the existing Home authz path', async () => {
    const source = await readFile(path.join(suppliesDir, 'http.ts'), 'utf8');
    assert.match(source, /router\.post\('\/:homeId\/supplies'/);
    assert.match(source, /router\.get\('\/:homeId\/supplies'/);
    assert.match(source, /createRequireHomeContext/);
    assert.match(source, /createRequireAuth/);
    assert.match(source, /setPrivateNoStoreHeaders/);
    assert.match(source, /\.strict\(\)/);
    assert.doesNotMatch(source, /lockHomeStructure/);
    assert.doesNotMatch(source, /FROM\s+supply_entries/i);
    assert.doesNotMatch(source, /FROM\s+memberships/i);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /better-auth/);
    assert.doesNotMatch(source, /supply\.created/);
    assert.doesNotMatch(source, /outbox/);
    assert.doesNotMatch(source, /router\.delete/i);
    assert.doesNotMatch(source, /\/obtain/);
    assert.doesNotMatch(source, /\/cancel/);
    assert.doesNotMatch(source, /\/claim/);
    assert.doesNotMatch(source, /\/release/);
    assert.doesNotMatch(source, /router\.patch/i);
    assert.doesNotMatch(source, /activeClaim|claimedBy|canClaim/);
  });
});
