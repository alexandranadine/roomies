import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const usersDir = path.dirname(fileURLToPath(import.meta.url));

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

void describe('authenticated user surface boundary', () => {
  void it('keeps Better Auth, Prisma, Home, and Membership out of this slice', async () => {
    // Composition (`create-roomies-api`) mounts homes separately and is not
    // part of the users domain boundary.
    const files = await walk(usersDir);

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const rel = file.replaceAll('\\', '/');

      assert.doesNotMatch(source, /from ['"]better-auth(?:\/[^'"]*)?['"]/, rel);
      assert.doesNotMatch(source, /from ['"]@better-auth\//, rel);
      assert.doesNotMatch(source, /from ['"]@prisma\//, rel);
      assert.doesNotMatch(source, /from ['"].*\/prisma\//, rel);
      assert.doesNotMatch(source, /\bprisma\b/, rel);
      assert.doesNotMatch(source, /FROM\s+homes/i, rel);
      assert.doesNotMatch(source, /FROM\s+memberships/i, rel);
      assert.doesNotMatch(source, /FROM\s+auth_identities/i, rel);
      assert.doesNotMatch(source, /FROM\s+auth_sessions/i, rel);
      assert.doesNotMatch(source, /FROM\s+auth_accounts/i, rel);
      assert.doesNotMatch(source, /\bhomeId\b/, rel);
      assert.doesNotMatch(source, /\bmembershipId\b/, rel);
      assert.doesNotMatch(source, /domains\/(?:homes|memberships)/, rel);
    }
  });

  void it('keeps the deletion marker port on users-only SQL without sibling imports', async () => {
    const source = await readFile(
      path.join(usersDir, 'canonical-user-deletion-marker.ts'),
      'utf8',
    );
    assert.match(source, /FROM users/);
    assert.match(source, /FOR UPDATE/);
    assert.match(source, /SET deleted_at = \$1/);
    assert.doesNotMatch(source, /DELETE FROM/i);
    assert.doesNotMatch(source, /FROM\s+homes/i);
    assert.doesNotMatch(source, /FROM\s+memberships/i);
    assert.doesNotMatch(source, /FROM\s+auth_/i);
    assert.doesNotMatch(source, /domains\/(?:homes|memberships)/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /better-auth/);
    assert.doesNotMatch(source, /Date\.now/);
    assert.doesNotMatch(source, /console\.(?:log|info|debug)\(/);
  });

  void it('does not import Better Auth from application/domain user modules', async () => {
    const applicationAndDomain = [
      path.join(usersDir, 'current-user.ts'),
      path.join(usersDir, 'get-current-user.ts'),
      path.join(usersDir, 'current-user-dto.ts'),
      path.join(usersDir, 'canonical-user-deletion-marker.ts'),
    ];

    for (const file of applicationAndDomain) {
      const source = await readFile(file, 'utf8');
      assert.doesNotMatch(source, /better-auth/);
      assert.doesNotMatch(source, /auth-runtime/);
      assert.doesNotMatch(source, /platform\/auth/);
      assert.doesNotMatch(source, /express/);
    }
  });

  void it('keeps deletion markers off the ordinary current-user surface', async () => {
    const surface = [
      path.join(usersDir, 'current-user.ts'),
      path.join(usersDir, 'get-current-user.ts'),
      path.join(usersDir, 'current-user-dto.ts'),
      path.join(usersDir, 'http.ts'),
    ];
    for (const file of surface) {
      const source = await readFile(file, 'utf8');
      const rel = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /deletedAt/, rel);
      assert.doesNotMatch(source, /deleted_at/, rel);
    }
  });
});
