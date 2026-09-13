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

void describe('homes application boundary', () => {
  void it('creates Home + ADMIN Membership through public writers without events', async () => {
    const source = await readFile(path.join(dir, 'create-home.ts'), 'utf8');
    assert.match(source, /insertHome/);
    assert.match(source, /insertActiveMembership|insertMembership/);
    assert.match(source, /evaluateHomeStructureInvariant/);
    assert.match(source, /runInReadCommittedTransaction/);
    assert.match(source, /role: 'ADMIN'/);
    assert.doesNotMatch(source, /memberships\/repository/);
    assert.doesNotMatch(source, /homes\/repository/);
    assert.doesNotMatch(source, /home-repository/);
    assert.doesNotMatch(source, /active-home-actor-lookup/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /better-auth/);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /Date\.now/);
    assert.doesNotMatch(
      source,
      /outboxWriter|createOutboxWriter|outbox_events/,
    );
    assert.doesNotMatch(source, /home\.created/);
    assert.doesNotMatch(source, /membership\.started/);
    assert.doesNotMatch(source, /owner|primaryAdmin|createdByUserId|founder/i);
    assert.doesNotMatch(source, /SERIALIZABLE/);
    assert.doesNotMatch(source, /pg_advisory/i);
  });

  void it('does not import repository internals or Express', async () => {
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
