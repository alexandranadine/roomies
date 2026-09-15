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
    if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test-helpers.ts')
    ) {
      files.push(full);
    }
  }
  return files;
}

void describe('account application boundary', () => {
  void it('coordinates public lifecycle ports inside one caller-owned transaction', async () => {
    const source = await readFile(
      path.join(dir, 'delete-account-lifecycle.ts'),
      'utf8',
    );
    assert.match(source, /lockCanonicalUser|lockByUserId/);
    assert.match(
      source,
      /findCanonicalIdentity|findCurrentCanonicalIdentityByUser/,
    );
    assert.match(source, /listTenures|listUserMembershipTenures/);
    assert.match(source, /lockActiveHomeStructureForEntry/);
    assert.match(source, /decideMembershipLeave/);
    assert.match(source, /decideArchiveFinalMember/);
    assert.match(source, /LastAdminRequiredError/);
    assert.match(source, /createApplyArchiveFinalMemberHomeFromPool/);
    assert.match(source, /createEndMembershipWithinHomeStructureFromPool/);
    assert.match(source, /createEraseAuthoredMaintenanceFromPool/);
    assert.match(source, /createEraseInvitationsForTargetEmailFromPool/);
    assert.match(source, /markDeleted/);
    assert.match(source, /teardownAuthForIdentity/);
    assert.match(source, /runInReadCommittedTransaction/);
    assert.match(source, /VOLUNTARY_LEAVE/);
    assert.doesNotMatch(source, /createLeaveMembershipFromPool/);
    assert.doesNotMatch(source, /createRemoveMembershipFromPool/);
    assert.doesNotMatch(source, /createArchiveFinalMemberHomeFromPool/);
    assert.doesNotMatch(source, /appendExpiredAuthSessionCookie/);
    assert.doesNotMatch(source, /expiredAuthSessionSetCookie/);
    assert.doesNotMatch(source, /createAccountRouter|router\.(?:delete|post)/);
    assert.doesNotMatch(source, /router\./);
    assert.doesNotMatch(source, /account\.deleted/);
    assert.doesNotMatch(source, /SERIALIZABLE/);
    assert.doesNotMatch(source, /pg_advisory/i);
    assert.doesNotMatch(source, /Date\.now/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /better-auth/);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /memberships\/repository/);
    assert.doesNotMatch(source, /homes\/repository/);
    assert.doesNotMatch(source, /tasks\/repository/);
    assert.doesNotMatch(source, /supplies\/repository/);
    assert.doesNotMatch(source, /notifications\/repository/);
    assert.doesNotMatch(source, /maintenance\/repository/);
    assert.doesNotMatch(source, /invitations\/repository/);
    assert.doesNotMatch(source, /console\.(?:log|info|debug)\(/);
    assert.match(
      source,
      /afterGlobalPreflight\?\.[\s\S]*deps\.clock\.now\(\)[\s\S]*markDeleted\(tx, \{[\s\S]*teardownAuthForIdentity/,
    );
  });

  void it('does not import repository internals, Express, or HTTP delete-account', async () => {
    const files = await walkProduction(dir);
    assert.ok(files.length > 0);
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const rel = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /memberships\/repository/, rel);
      assert.doesNotMatch(source, /homes\/repository/, rel);
      assert.doesNotMatch(source, /tasks\/repository/, rel);
      assert.doesNotMatch(source, /supplies\/repository/, rel);
      assert.doesNotMatch(source, /notifications\/repository/, rel);
      assert.doesNotMatch(source, /from ['"]express['"]/, rel);
      assert.doesNotMatch(source, /better-auth/, rel);
      assert.doesNotMatch(source, /from ['"]pg['"]/, rel);
      assert.doesNotMatch(source, /createAccountRouter/, rel);
    }
  });

  void it('does not create an HTTP or frontend account surface', async () => {
    const names = (await readdir(dir)).filter((name) => name.endsWith('.ts'));
    assert.equal(names.includes('http.ts'), false);
  });
});
