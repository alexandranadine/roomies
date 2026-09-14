import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const outboxDir = path.dirname(fileURLToPath(import.meta.url));
const backendSrc = path.resolve(outboxDir, '../..');
const repoRoot = path.resolve(backendSrc, '../..');

async function walk(dir: string, includeTests = false): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
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

void describe('platform/outbox boundary', () => {
  void it('does not import domains, Prisma, Express, or frontend', async () => {
    const files = await walk(outboxDir, false);
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const rel = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /from ['"]pg['"]/, rel);
      assert.doesNotMatch(source, /from ['"]express['"]/, rel);
      assert.doesNotMatch(source, /from ['"]@prisma\//, rel);
      assert.doesNotMatch(source, /from ['"].*\/domains\//, rel);
      assert.doesNotMatch(source, /from ['"].*\/application\//, rel);
      assert.doesNotMatch(source, /activity\/repository/, rel);
      assert.doesNotMatch(source, /maintenance\/repository/, rel);
      assert.doesNotMatch(source, /tasks\/repository/, rel);
      assert.doesNotMatch(source, /supplies\/repository/, rel);
      assert.doesNotMatch(source, /frontend/, rel);
      assert.doesNotMatch(source, /better-auth/, rel);
      assert.doesNotMatch(source, /SERIALIZABLE/, rel);
      assert.doesNotMatch(source, /pg_advisory/i, rel);
      assert.doesNotMatch(source, /redis/i, rel);
      assert.doesNotMatch(source, /kafka/i, rel);
      assert.doesNotMatch(source, /handlerId:\s*['"]activity['"]/, rel);
      assert.doesNotMatch(source, /handlerId:\s*['"]notifications['"]/, rel);
    }
  });

  void it('does not log payloads or protected household strings', async () => {
    const files = await walk(outboxDir, false);
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const rel = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /JSON\.stringify\(event\.payload\)/, rel);
      assert.doesNotMatch(source, /JSON\.stringify\(row\.payload\)/, rel);
      assert.doesNotMatch(source, /console\.error\(error/, rel);
      assert.doesNotMatch(source, /console\.info\(error/, rel);
      assert.doesNotMatch(source, /\btitle\b/, rel);
      assert.doesNotMatch(source, /\bemail\b/, rel);
      assert.doesNotMatch(source, /Maintenance/, rel);
      assert.doesNotMatch(source, /membershipId/, rel);
    }
  });

  void it('keeps PostgreSQL suites on a dedicated TEST_DATABASE_URL', async () => {
    for (const name of [
      'consumer.integration.test.ts',
      'consumer.concurrency.integration.test.ts',
    ]) {
      const source = await readFile(path.join(outboxDir, name), 'utf8');
      assert.doesNotMatch(source, /loadRuntimeEnvFiles/);
      assert.doesNotMatch(source, /load-dotenv/);
      assert.match(source, /resolveSafeDedicatedTestDatabaseUrl/);
      assert.match(source, /skipUnlessDedicatedTestDatabase/);
      assert.match(source, /TEST_DATABASE_URL/);
      assert.doesNotMatch(source, /resolveTestDatabaseUrl\(\)/);
    }
  });

  void it('does not add outbox consumer types to frontend or shared', async () => {
    for (const dir of [
      path.join(repoRoot, 'frontend/src'),
      path.join(repoRoot, 'shared/src'),
    ]) {
      const files = await walk(dir, true);
      for (const file of files) {
        const source = await readFile(file, 'utf8');
        const rel = file.replaceAll('\\', '/');
        assert.doesNotMatch(source, /OutboxConsumer/, rel);
        assert.doesNotMatch(source, /createOutboxHandlerRegistry/, rel);
        assert.doesNotMatch(source, /outbox_events/, rel);
      }
    }
  });

  void it('leaves the transaction kernel outbox-consumer-free', async () => {
    const source = await readFile(
      path.join(backendSrc, 'platform/persistence/transaction.ts'),
      'utf8',
    );
    assert.doesNotMatch(source, /platform\/outbox/);
    assert.doesNotMatch(source, /createOutboxConsumer/);
  });
});
