import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const homesDir = path.dirname(fileURLToPath(import.meta.url));

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

void describe('homes domain boundary', () => {
  void it('keeps policies free of persistence and Express', async () => {
    const source = await readFile(path.join(homesDir, 'policies.ts'), 'utf8');
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /from ['"]@prisma\//);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /isHomeAdmin/);
    assert.doesNotMatch(source, /role\s*===\s*['"]ADMIN['"]/);
    assert.doesNotMatch(source, /FROM\s+memberships/i);
  });

  void it('does not import Membership repository internals', async () => {
    const files = await walk(homesDir);

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const rel = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /memberships\/repository/, rel);
      assert.doesNotMatch(source, /active-home-actor-lookup/, rel);
    }
  });

  void it('does not query Membership tables from HTTP', async () => {
    const httpFiles = [
      path.join(homesDir, 'http.ts'),
      path.resolve(homesDir, '../../platform/http/home-context.ts'),
    ];
    for (const file of httpFiles) {
      const source = await readFile(file, 'utf8');
      assert.doesNotMatch(source, /FROM\s+memberships/i);
      assert.doesNotMatch(source, /FROM\s+homes/i);
      assert.doesNotMatch(source, /from ['"]pg['"]/);
    }
  });

  void it('does not put Home policy inside platform/auth', async () => {
    const source = await readFile(path.join(homesDir, 'policies.ts'), 'utf8');
    assert.doesNotMatch(source, /platform\/auth['"]/);
    assert.doesNotMatch(source, /better-auth/);
  });
});
