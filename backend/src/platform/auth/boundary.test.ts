import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const backendSrc = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

async function walk(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
      continue;
    }
    if (entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

void describe('auth platform boundary', () => {
  void it('keeps Better Auth types inside platform/auth and auth-runtime', async () => {
    const files = await walk(backendSrc);
    const leaks: string[] = [];

    for (const file of files) {
      const rel = file.replaceAll('\\', '/');
      if (rel.includes('/platform/auth/')) {
        continue;
      }
      const source = await readFile(file, 'utf8');
      if (
        /from ['"]better-auth(?:\/[^'"]*)?['"]/.test(source) ||
        /from ['"]@better-auth\//.test(source)
      ) {
        leaks.push(rel);
      }
    }

    assert.deepEqual(leaks, []);
  });

  void it('does not introduce Home or Membership authorization', async () => {
    const authDir = path.join(backendSrc, 'platform/auth');
    const files = await walk(authDir);

    for (const file of files) {
      if (file.endsWith('.test.ts')) {
        continue;
      }
      const source = await readFile(file, 'utf8');
      assert.doesNotMatch(source, /FROM\s+homes/i);
      assert.doesNotMatch(source, /FROM\s+memberships/i);
      assert.doesNotMatch(source, /\bhomeId\b/);
      assert.doesNotMatch(source, /\bmembershipId\b/);
    }
  });
});
