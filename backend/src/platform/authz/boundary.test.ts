import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const authzDir = path.dirname(fileURLToPath(import.meta.url));
const backendSrc = path.resolve(authzDir, '../..');
const repoRoot = path.resolve(backendSrc, '../..');

async function walk(dir: string, includeTests = true): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === 'dist-ssr'
      ) {
        continue;
      }
      files.push(...(await walk(full, includeTests)));
      continue;
    }
    if (!entry.name.endsWith('.ts')) {
      continue;
    }
    if (!includeTests && entry.name.endsWith('.test.ts')) {
      continue;
    }
    files.push(full);
  }
  return files;
}

void describe('authorization platform boundary', () => {
  void it('does not import Better Auth, Express, or persistence', async () => {
    const files = await walk(authzDir, false);

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      assert.doesNotMatch(source, /better-auth/);
      assert.doesNotMatch(source, /auth-runtime/);
      assert.doesNotMatch(source, /from ['"]express['"]/);
      assert.doesNotMatch(source, /from ['"]pg['"]/);
      assert.doesNotMatch(source, /from ['"]@prisma\//);
      assert.doesNotMatch(source, /from ['"].*\/prisma\//);
      assert.doesNotMatch(source, /from ['"].*\/domains\//);
      assert.doesNotMatch(source, /StructuralIntegrityError/);
      assert.doesNotMatch(source, /TransactionInfrastructureError/);
    }
  });

  void it('does not add Home authorization to frontend or shared', async () => {
    const surfaces = [
      path.join(repoRoot, 'frontend/src'),
      path.join(repoRoot, 'shared/src'),
    ];

    for (const dir of surfaces) {
      const files = await walk(dir);
      for (const file of files) {
        const source = await readFile(file, 'utf8');
        const rel = file.replaceAll('\\', '/');
        assert.doesNotMatch(source, /ActiveHomeActor/, rel);
        assert.doesNotMatch(source, /HOME_ACTION/, rel);
        assert.doesNotMatch(source, /decideHomeRead/, rel);
        assert.doesNotMatch(source, /isHomeAdmin/, rel);
        assert.doesNotMatch(source, /platform\/authz/, rel);
      }
    }
  });

  void it('does not install a global Admin bypass', async () => {
    const files = await walk(backendSrc, false);

    for (const file of files) {
      const rel = file.replaceAll('\\', '/');
      if (rel.includes('/platform/authz/home-role.ts')) {
        continue;
      }
      const source = await readFile(file, 'utf8');
      assert.doesNotMatch(
        source,
        /if\s*\(\s*actor\.role\s*===\s*['"]ADMIN['"]\s*\)\s*return\s+allow\s*\(/,
        rel,
      );
    }
  });
});
