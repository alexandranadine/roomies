import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const backendSrc = path.resolve(dir, '../..');

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

void describe('object-store boundary', () => {
  void it('keeps the interface free of AWS SDK, Express, and Sharp', async () => {
    const source = await readFile(path.join(dir, 'types.ts'), 'utf8');
    assert.doesNotMatch(source, /from ['"]@aws-sdk\//);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /from ['"]sharp['"]/);
    assert.doesNotMatch(source, /ListBucket|multipart|public-url|minio|redis/i);
  });

  void it('confines AWS SDK types to the Cloudflare adapter', async () => {
    const files = await walk(dir, false);
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const rel = file.replaceAll('\\', '/');
      if (rel.endsWith('/cloudflare-r2.ts')) {
        assert.match(source, /@aws-sdk\/client-s3/);
        assert.match(source, /@aws-sdk\/s3-request-presigner/);
        assert.doesNotMatch(source, /from ['"]express['"]/, rel);
        assert.doesNotMatch(source, /from ['"]sharp['"]/, rel);
        continue;
      }
      assert.doesNotMatch(source, /from ['"]@aws-sdk\//, rel);
      assert.doesNotMatch(source, /from ['"]express['"]/, rel);
      assert.doesNotMatch(source, /from ['"]sharp['"]/, rel);
    }
  });

  void it('does not use unbounded AWS body helpers', async () => {
    const files = await walk(dir, false);
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const rel = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /transformToByteArray/, rel);
      assert.doesNotMatch(source, /transformToString/, rel);
      assert.doesNotMatch(source, /@aws-sdk\/lib-storage/, rel);
    }
  });

  void it('keeps domain and application free of AWS SDK and Sharp', async () => {
    for (const folder of ['domains', 'application']) {
      const files = await walk(path.join(backendSrc, folder), false);
      for (const file of files) {
        const source = await readFile(file, 'utf8');
        const rel = file.replaceAll('\\', '/');
        assert.doesNotMatch(source, /from ['"]@aws-sdk\//, rel);
        assert.doesNotMatch(source, /from ['"]sharp['"]/, rel);
      }
    }
  });
});
