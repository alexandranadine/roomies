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

  void it('creates SupplyEntries without repository internals or outbox', async () => {
    const source = await readFile(
      path.join(dir, 'create-supply-entry.ts'),
      'utf8',
    );
    assert.match(source, /decideSupplyCreate/);
    assert.match(source, /lockHomeAndExactMemberships/);
    assert.match(source, /insertSupplyEntry/);
    assert.match(source, /runInReadCommittedTransaction/);
    assert.match(source, /normalizeSupplyTitle/);
    assert.match(source, /createdByMembershipId: actor\.membershipId/);
    assert.match(source, /status: 'OPEN'/);
    assert.match(source, /obtainedAt: null/);
    assert.match(source, /canceledAt: null/);
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
    assert.doesNotMatch(source, /supply\.created/);
    assert.doesNotMatch(source, /insertSupplyClaim/);
    assert.doesNotMatch(source, /lockSupplyEntryByHomeAndId/);
    assert.doesNotMatch(source, /SERIALIZABLE/);
    assert.doesNotMatch(source, /pg_advisory/i);
    assert.doesNotMatch(source, /user_id/);
  });

  void it('lists Home Supplies through the public repository projection', async () => {
    const source = await readFile(
      path.join(dir, 'list-home-supplies.ts'),
      'utf8',
    );
    assert.match(source, /decideSupplyList/);
    assert.match(source, /listSupplyEntriesByHome/);
    assert.match(source, /listOpenEntriesByHome/);
    assert.match(source, /listSupplyEntriesByHomeAndStatus/);
    assert.match(source, /ListedSupplyEntry/);
    assert.doesNotMatch(source, /decideHomeRead/);
    assert.doesNotMatch(source, /memberships\/repository/);
    assert.doesNotMatch(source, /homes\/repository/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /better-auth/);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /outbox/);
    assert.doesNotMatch(source, /lockHomeStructure/);
    assert.doesNotMatch(source, /lockHomeAndExactMemberships/);
    assert.doesNotMatch(source, /FOR UPDATE/i);
    assert.doesNotMatch(source, /LEFT JOIN/);
    assert.doesNotMatch(source, /findActiveClaimByEntry/);
    assert.doesNotMatch(source, /claimedBy|canClaim/);
  });

  void it('claims through Home lock and Supplies primitives without outbox', async () => {
    const source = await readFile(
      path.join(dir, 'claim-supply-entry.ts'),
      'utf8',
    );
    assert.match(source, /decideSupplyClaim/);
    assert.match(source, /lockHomeAndExactMemberships/);
    assert.match(source, /lockSupplyEntryByHomeAndId/);
    assert.match(source, /lockActiveClaimByEntry/);
    assert.match(source, /insertSupplyClaim/);
    assert.match(source, /runInReadCommittedTransaction/);
    assert.match(source, /claimantMembershipId: actor\.membershipId/);
    assert.doesNotMatch(source, /findActiveClaimByEntry/);
    assert.doesNotMatch(source, /memberships\/repository/);
    assert.doesNotMatch(source, /homes\/repository/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /Date\.now/);
    assert.doesNotMatch(source, /new Date\(/);
    assert.doesNotMatch(source, /outbox/);
    assert.doesNotMatch(source, /supply\.claimed/);
    assert.doesNotMatch(source, /SERIALIZABLE/);
    assert.doesNotMatch(source, /pg_advisory/i);
    assert.doesNotMatch(source, /Idempotency-Key/);
  });

  void it('releases through ownership policy and conditional update without Admin bypass', async () => {
    const source = await readFile(
      path.join(dir, 'release-supply-claim.ts'),
      'utf8',
    );
    assert.match(source, /decideSupplyReleaseClaim/);
    assert.match(source, /lockHomeAndExactMemberships/);
    assert.match(source, /lockSupplyEntryByHomeAndId/);
    assert.match(source, /lockActiveClaimByEntry/);
    assert.match(source, /releaseActiveClaimOwnedByMembership/);
    assert.match(source, /runInReadCommittedTransaction/);
    assert.doesNotMatch(source, /findActiveClaimByEntry/);
    assert.doesNotMatch(source, /isHomeAdmin/);
    assert.doesNotMatch(source, /memberships\/repository/);
    assert.doesNotMatch(source, /homes\/repository/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /Date\.now/);
    assert.doesNotMatch(source, /new Date\(/);
    assert.doesNotMatch(source, /outbox/);
    assert.doesNotMatch(source, /supply\.released/);
    assert.doesNotMatch(source, /SERIALIZABLE/);
    assert.doesNotMatch(source, /pg_advisory/i);
    assert.doesNotMatch(source, /Idempotency-Key/);
  });

  void it('marks obtained through ordinary policy without claim ownership', async () => {
    const source = await readFile(
      path.join(dir, 'mark-supply-entry-obtained.ts'),
      'utf8',
    );
    assert.match(source, /decideSupplyMarkObtained/);
    assert.match(source, /lockHomeAndExactMemberships/);
    assert.match(source, /lockSupplyEntryByHomeAndId/);
    assert.match(source, /lockActiveClaimByEntry/);
    assert.match(source, /releaseActiveClaimForEntryTerminalization/);
    assert.match(source, /terminalizeSupplyEntryAsObtained/);
    assert.match(source, /runInReadCommittedTransaction/);
    assert.match(source, /reason: 'ENTRY_OBTAINED'/);
    assert.doesNotMatch(source, /decideSupplyReleaseClaim/);
    assert.doesNotMatch(source, /isHomeAdmin/);
    assert.doesNotMatch(source, /memberships\/repository/);
    assert.doesNotMatch(source, /homes\/repository/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /Date\.now/);
    assert.doesNotMatch(source, /new Date\(/);
    assert.doesNotMatch(source, /outbox/);
    assert.doesNotMatch(source, /supply\.obtained/);
    assert.doesNotMatch(source, /SERIALIZABLE/);
    assert.doesNotMatch(source, /pg_advisory/i);
    assert.doesNotMatch(source, /Idempotency-Key/);
  });

  void it('cancels through ordinary policy without claim ownership', async () => {
    const source = await readFile(
      path.join(dir, 'cancel-supply-entry.ts'),
      'utf8',
    );
    assert.match(source, /decideSupplyCancel/);
    assert.match(source, /lockHomeAndExactMemberships/);
    assert.match(source, /lockSupplyEntryByHomeAndId/);
    assert.match(source, /lockActiveClaimByEntry/);
    assert.match(source, /releaseActiveClaimForEntryTerminalization/);
    assert.match(source, /terminalizeSupplyEntryAsCanceled/);
    assert.match(source, /runInReadCommittedTransaction/);
    assert.match(source, /reason: 'ENTRY_CANCELED'/);
    assert.doesNotMatch(source, /decideSupplyReleaseClaim/);
    assert.doesNotMatch(source, /isHomeAdmin/);
    assert.doesNotMatch(source, /memberships\/repository/);
    assert.doesNotMatch(source, /homes\/repository/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /Date\.now/);
    assert.doesNotMatch(source, /new Date\(/);
    assert.doesNotMatch(source, /outbox/);
    assert.doesNotMatch(source, /supply\.canceled/);
    assert.doesNotMatch(source, /SERIALIZABLE/);
    assert.doesNotMatch(source, /pg_advisory/i);
    assert.doesNotMatch(source, /Idempotency-Key/);
  });
});
