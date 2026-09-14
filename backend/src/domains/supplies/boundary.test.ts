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
      if (relative.endsWith('/events.ts')) {
        assert.match(source, /import type \{ OutboxEventInput \}/);
        assert.doesNotMatch(source, /createOutboxWriter/);
        assert.doesNotMatch(source, /title/);
        assert.doesNotMatch(source, /claimantMembershipId/);
        assert.doesNotMatch(source, /createdByMembershipId/);
        assert.doesNotMatch(source, /obtainedByMembershipId/);
        assert.doesNotMatch(source, /userId/);
      } else {
        assert.doesNotMatch(source, /outbox/, relative);
      }
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
      'lockSupplyEntryByHomeAndId',
      'lockActiveClaimByEntry',
      'releaseActiveClaimOwnedByMembership',
      'listClaimsForEntry',
      'listOpenEntriesByHome',
      'listSupplyEntriesByHome',
      'listSupplyEntriesByHomeAndStatus',
      'releaseActiveClaimsForMembership',
      'releaseActiveClaimForEntryTerminalization',
      'terminalizeSupplyEntryAsObtained',
      'terminalizeSupplyEntryAsCanceled',
    ]) {
      assert.match(source, new RegExp(primitive));
    }
    assert.match(source, /RELEASE_ACTIVE_CLAIMS_FOR_MEMBERSHIP_SQL/);
    assert.match(source, /claimant_membership_id = \$2::uuid/);
    assert.match(source, /release_reason = 'MEMBERSHIP_ENDED'/);
    assert.match(source, /home_id = \$1::uuid/);
    assert.match(source, /released_at IS NULL/);
    assert.match(source, /ORDER BY claimed_at ASC, id ASC/);
    assert.match(source, /ORDER BY e\.created_at ASC, e\.id ASC/);
    assert.match(source, /LIST_SUPPLY_ENTRIES_BY_HOME_SQL/);
    assert.match(source, /LIST_SUPPLY_ENTRIES_BY_HOME_AND_STATUS_SQL/);
    assert.match(source, /LEFT JOIN supply_claims/);
    assert.match(source, /c\.home_id = e\.home_id/);
    assert.match(source, /c\.supply_entry_id = e\.id/);
    assert.match(source, /c\.released_at IS NULL/);
    assert.match(source, /supply_claims_one_active_per_entry_1e26d778/);
    assert.match(source, /LOCK_SUPPLY_ENTRY_BY_HOME_AND_ID_SQL/);
    assert.match(source, /LOCK_ACTIVE_CLAIM_BY_ENTRY_SQL/);
    assert.match(source, /RELEASE_ACTIVE_CLAIM_OWNED_BY_MEMBERSHIP_SQL/);
    assert.match(source, /RELEASE_ACTIVE_CLAIM_FOR_ENTRY_TERMINALIZATION_SQL/);
    assert.match(source, /TERMINALIZE_SUPPLY_ENTRY_AS_OBTAINED_SQL/);
    assert.match(source, /TERMINALIZE_SUPPLY_ENTRY_AS_CANCELED_SQL/);
    assert.doesNotMatch(source, /DELETE /i);
    assert.doesNotMatch(source, /claimed_by_membership_id/);
    assert.doesNotMatch(source, /quantity|price|reimbursement/i);
    assert.doesNotMatch(source, /findActiveClaimByEntry\([\s\S]*FOR UPDATE/i);
  });

  void it('keeps Activity source lookup free of title, claimant, and creator', async () => {
    const source = await readFile(
      path.join(suppliesDir, 'find-supply-activity-source.ts'),
      'utf8',
    );
    assert.match(source, /FIND_SUPPLY_ACTIVITY_SOURCE_SQL/);
    assert.match(source, /expectedHomeId/);
    assert.doesNotMatch(source, /e\.title/);
    assert.doesNotMatch(source, /created_by_membership_id/);
    assert.doesNotMatch(source, /claimant/);
    assert.doesNotMatch(source, /user_id/);
    assert.doesNotMatch(source, /email/);
    assert.doesNotMatch(source, /\brole\b/);
    assert.doesNotMatch(source, /isHomeAdmin/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /activity\/repository/);
    assert.doesNotMatch(source, /insertHomeVisibleActivity/);
    assert.doesNotMatch(source, /from ['"]\.\/repository/);
  });

  void it('exposes creator and obtain evidence without claim or identity data to Notifications', async () => {
    const source = await readFile(
      path.join(suppliesDir, 'find-supply-notification-source.ts'),
      'utf8',
    );
    assert.match(source, /FIND_SUPPLY_NOTIFICATION_SOURCE_SQL/);
    assert.match(source, /created_by_membership_id/);
    assert.match(source, /obtained_by_membership_id/);
    assert.match(source, /obtained_at/);
    assert.match(source, /expectedHomeId/);
    assert.doesNotMatch(source, /e\.title/);
    assert.doesNotMatch(source, /supply_claims|claimant/);
    assert.doesNotMatch(source, /user_id|email|\bname\b/);
    assert.doesNotMatch(source, /from ['"]\.\/repository/);
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
    for (const name of [
      'create-policy.ts',
      'list-policy.ts',
      'claim-policy.ts',
      'release-policy.ts',
      'obtain-policy.ts',
      'cancel-policy.ts',
      'actions.ts',
    ]) {
      const source = await readFile(path.join(suppliesDir, name), 'utf8');
      assert.doesNotMatch(source, /decideHomeRead/);
      assert.doesNotMatch(source, /isHomeAdmin/);
      assert.doesNotMatch(source, /from ['"]pg['"]/);
      assert.doesNotMatch(source, /from ['"]express['"]/);
      assert.doesNotMatch(source, /FOR UPDATE/i);
      assert.doesNotMatch(source, /actor\.userId|input\.userId/);
    }
    const actions = await readFile(
      path.join(suppliesDir, 'actions.ts'),
      'utf8',
    );
    assert.match(actions, /supply\.create/);
    assert.match(actions, /supply\.list/);
    assert.match(actions, /supply\.claim/);
    assert.match(actions, /supply\.release_claim/);
    assert.match(actions, /supply\.mark_obtained/);
    assert.match(actions, /supply\.cancel/);
    assert.doesNotMatch(actions, /supply\.reopen/);
    assert.doesNotMatch(actions, /supply\.delete/);
  });

  void it('keeps Supply HTTP adapter-only on the existing Home authz path', async () => {
    const source = await readFile(path.join(suppliesDir, 'http.ts'), 'utf8');
    assert.match(source, /router\.post\('\/:homeId\/supplies'/);
    assert.match(source, /router\.get\('\/:homeId\/supplies'/);
    assert.match(
      source,
      /router\.post\('\/:homeId\/supplies\/:supplyEntryId\/claim'/,
    );
    assert.match(
      source,
      /router\.post\(\s*'\/:homeId\/supplies\/:supplyEntryId\/release-claim'/,
    );
    assert.match(
      source,
      /router\.post\(\s*'\/:homeId\/supplies\/:supplyEntryId\/obtain'/,
    );
    assert.match(
      source,
      /router\.post\(\s*'\/:homeId\/supplies\/:supplyEntryId\/cancel'/,
    );
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
    assert.doesNotMatch(source, /router\.patch/i);
    assert.doesNotMatch(source, /res\.status\(204\)\.json/);
    assert.doesNotMatch(source, /claimedBy|canClaim/);
  });
});
