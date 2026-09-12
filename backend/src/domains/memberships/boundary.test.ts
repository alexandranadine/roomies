import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const membershipsDir = path.dirname(fileURLToPath(import.meta.url));
const publicIndex = path.join(membershipsDir, 'index.ts');

async function walk(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
      continue;
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

void describe('memberships domain boundary', () => {
  void it('keeps the public barrel free of repository paths', async () => {
    const source = await readFile(publicIndex, 'utf8');
    assert.doesNotMatch(source, /repository\//);
    assert.doesNotMatch(source, /active-home-actor-lookup/);
    assert.doesNotMatch(source, /better-auth/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
  });

  void it('keeps role policy free of persistence, HTTP, and SQL', async () => {
    const source = await readFile(
      path.join(membershipsDir, 'role-policy.ts'),
      'utf8',
    );
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /FOR UPDATE/i);
    assert.doesNotMatch(source, /UPDATE memberships/i);
    assert.doesNotMatch(source, /from ['"].*\/http['"]/);
    assert.doesNotMatch(source, /LastAdminRequiredError/);
    assert.doesNotMatch(source, /ForbiddenError/);
  });

  void it('keeps remove policy free of persistence, HTTP, and SQL', async () => {
    const source = await readFile(
      path.join(membershipsDir, 'remove-policy.ts'),
      'utf8',
    );
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /FOR UPDATE/i);
    assert.doesNotMatch(source, /UPDATE memberships/i);
    assert.doesNotMatch(source, /ended_at/);
    assert.doesNotMatch(source, /from ['"].*\/http['"]/);
    assert.doesNotMatch(source, /LastAdminRequiredError/);
    assert.doesNotMatch(source, /LastRoommateRequiresArchiveError/);
    assert.doesNotMatch(source, /ForbiddenError/);
    assert.doesNotMatch(source, /userId/);
    assert.doesNotMatch(source, /SET role/i);
    assert.doesNotMatch(source, /VOLUNTARY_LEAVE/);
  });

  void it('keeps leave policy free of persistence, HTTP, and SQL', async () => {
    const source = await readFile(
      path.join(membershipsDir, 'leave-policy.ts'),
      'utf8',
    );
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /FOR UPDATE/i);
    assert.doesNotMatch(source, /UPDATE memberships/i);
    assert.doesNotMatch(source, /ended_at/);
    assert.doesNotMatch(source, /from ['"].*\/http['"]/);
    assert.doesNotMatch(source, /LastAdminRequiredError/);
    assert.doesNotMatch(source, /LastRoommateRequiresArchiveError/);
    assert.doesNotMatch(source, /ForbiddenError/);
    assert.doesNotMatch(source, /userId/);
    assert.doesNotMatch(source, /SET role/i);
  });

  void it('keeps domain event contracts typed against platform events only', async () => {
    const source = await readFile(
      path.join(membershipsDir, 'events.ts'),
      'utf8',
    );
    assert.match(source, /import type \{ OutboxEventInput \}/);
    assert.doesNotMatch(source, /from ['"].*\/http['"]/);
    assert.doesNotMatch(source, /home-dto/);
    assert.doesNotMatch(source, /current-user-dto/);
    assert.doesNotMatch(source, /better-auth/);
    assert.doesNotMatch(source, /auth-runtime/);
    assert.doesNotMatch(source, /session/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /createOutboxWriter/);
    assert.doesNotMatch(source, /email/);
    assert.match(source, /MembershipRole/);
    assert.match(source, /VOLUNTARY_LEAVE/);
    assert.match(source, /ADMIN_REMOVAL/);
    assert.match(source, /HOME_ARCHIVED/);
    assert.match(source, /previousRole/);
    assert.match(source, /newRole/);
    assert.doesNotMatch(source, /payload: Object.freeze\(\{[^}]*\brole:/);
  });

  void it('does not import Home repository internals', async () => {
    const files = await walk(membershipsDir);

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const rel = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /homes\/repository/, rel);
      assert.doesNotMatch(source, /home-repository/, rel);
      assert.doesNotMatch(source, /application\/home-administration/, rel);
      assert.doesNotMatch(source, /domains\/tasks/, rel);
      assert.doesNotMatch(source, /domains\/supplies/, rel);
    }
  });

  void it('owns the exact active Membership ending UPDATE', async () => {
    const source = await readFile(
      path.join(membershipsDir, 'update-active-membership-ended-at.ts'),
      'utf8',
    );
    assert.match(source, /SET ended_at = \$1/);
    assert.match(source, /WHERE id = \$2/);
    assert.match(source, /AND home_id = \$3/);
    assert.match(source, /AND ended_at IS NULL/);
    assert.doesNotMatch(source, /user_id/);
    assert.doesNotMatch(source, /DELETE/i);
    assert.doesNotMatch(source, /SET role/i);
    assert.doesNotMatch(source, /SET joined_at/i);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /better-auth/);
    assert.doesNotMatch(source, /domains\/tasks/);
    assert.doesNotMatch(source, /domains\/supplies/);
    assert.doesNotMatch(source, /application\/home-administration/);
  });

  void it('exposes leave and remove without archive or ending-seam internals', async () => {
    const source = await readFile(path.join(membershipsDir, 'http.ts'), 'utf8');
    assert.match(
      source,
      /router\.post\('\/:homeId\/memberships\/:membershipId\/leave'/,
    );
    assert.match(
      source,
      /router\.post\('\/:homeId\/memberships\/:membershipId\/remove'/,
    );
    assert.doesNotMatch(source, /router\.delete\s*\(/);
    assert.doesNotMatch(source, /archive/i);
    assert.doesNotMatch(source, /endMembershipWithinHomeStructure/);
    assert.doesNotMatch(source, /decideMembershipLeave/);
    assert.doesNotMatch(source, /decideMembershipRemove/);
    assert.doesNotMatch(source, /LastAdminRequiredError/);
    assert.doesNotMatch(source, /LastRoommateRequiresArchiveError/);
  });
});
