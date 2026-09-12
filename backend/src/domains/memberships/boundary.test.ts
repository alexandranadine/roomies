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

  void it('does not import Home repository internals', async () => {
    const files = await walk(membershipsDir);

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const rel = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /homes\/repository/, rel);
      assert.doesNotMatch(source, /home-repository/, rel);
    }
  });
});
