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

void describe('memberships application boundary', () => {
  void it('lists through typed membership.list_active and the public reader', async () => {
    const source = await readFile(
      path.join(dir, 'list-active-home-memberships.ts'),
      'utf8',
    );
    assert.match(source, /decideMembershipListActive/);
    assert.match(source, /listActiveByHome/);
    assert.match(source, /actor\.membershipId/);
    assert.match(source, /ConcealedNotFoundError/);
    assert.doesNotMatch(source, /filter\(/);
    assert.doesNotMatch(source, /sort\(/);
    assert.doesNotMatch(source, /isSelf/);
    assert.doesNotMatch(source, /userId/);
    assert.doesNotMatch(source, /isHomeAdmin/);
    assert.doesNotMatch(source, /decideHomeRead/);
    assert.doesNotMatch(source, /lockHomeStructure/);
    assert.doesNotMatch(source, /memberships\/repository/);
    assert.doesNotMatch(source, /homes\/repository/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /better-auth/);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /email/);
    assert.doesNotMatch(source, /invitations/);
    assert.doesNotMatch(source, /FOR UPDATE/i);
    assert.doesNotMatch(source, /outbox/);
  });

  void it('does not import repository internals, Express, or sibling writers', async () => {
    const files = await walkProduction(dir);
    assert.ok(files.length > 0);
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
