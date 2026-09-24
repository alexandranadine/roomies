import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

async function walk(root: string, includeTests = false): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
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

void describe('image processor boundary', () => {
  void it('does not import Express, AWS SDK, or HTTP error types', async () => {
    const files = await walk(dir, false);
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const rel = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /from ['"]express['"]/, rel);
      assert.doesNotMatch(source, /from ['"]@aws-sdk\//, rel);
      assert.doesNotMatch(source, /status\s*=\s*413/, rel);
      assert.doesNotMatch(source, /withMetadata\(/, rel);
      assert.doesNotMatch(source, /unlimited:\s*true/, rel);
    }
  });

  void it('configures Sharp concurrency and cache at bootstrap', async () => {
    const source = await readFile(path.join(dir, 'configure.ts'), 'utf8');
    assert.match(source, /sharp\.concurrency\(1\)/);
    assert.match(source, /memory:\s*32/);
    assert.match(source, /files:\s*0/);
    assert.match(source, /items:\s*20/);
  });
});
