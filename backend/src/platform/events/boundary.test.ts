import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const eventsDir = path.dirname(fileURLToPath(import.meta.url));
const backendSrc = path.resolve(eventsDir, '../..');
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

void describe('platform/events boundary', () => {
  void it('does not import Better Auth, Express, frontend, domains, or workers', async () => {
    const files = await walk(eventsDir, false);

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const rel = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /better-auth/, rel);
      assert.doesNotMatch(source, /auth-runtime/, rel);
      assert.doesNotMatch(source, /from ['"]express['"]/, rel);
      assert.doesNotMatch(source, /frontend/, rel);
      assert.doesNotMatch(source, /@roomies\/shared/, rel);
      assert.doesNotMatch(source, /from ['"].*\/domains\//, rel);
      assert.doesNotMatch(source, /from ['"]pg['"]/, rel);
      assert.doesNotMatch(source, /from ['"]@prisma\//, rel);
      assert.doesNotMatch(source, /from ['"].*\/prisma\//, rel);
      assert.doesNotMatch(source, /pool\.connect/, rel);
      assert.doesNotMatch(source, /createDatabasePool/, rel);
      assert.doesNotMatch(source, /outbox-worker/, rel);
      assert.doesNotMatch(source, /platform\/outbox-worker/, rel);
      assert.doesNotMatch(source, /consumer/i, rel);
      assert.doesNotMatch(source, /AuthorizationIntegrityError/, rel);
      assert.doesNotMatch(source, /StructuralIntegrityError/, rel);
      assert.doesNotMatch(source, /VOLUNTARY_LEAVE/, rel);
      assert.doesNotMatch(source, /ADMIN_REMOVAL/, rel);
      assert.doesNotMatch(source, /MembershipEndedCause/, rel);
      assert.doesNotMatch(source, /previousRole/, rel);
      assert.doesNotMatch(source, /MembershipRole/, rel);
    }
  });

  void it('keeps the outbox PostgreSQL suite off the development database', async () => {
    const source = await readFile(
      path.join(eventsDir, 'outbox-writer.integration.test.ts'),
      'utf8',
    );
    assert.doesNotMatch(source, /loadRuntimeEnvFiles/);
    assert.doesNotMatch(source, /load-dotenv/);
    assert.match(source, /resolveSafeDedicatedTestDatabaseUrl/);
    assert.match(source, /skipUnlessDedicatedTestDatabase/);
    assert.match(source, /TEST_DATABASE_URL/);
    assert.doesNotMatch(
      source,
      /!process\.env\['TEST_DATABASE_URL'\] && !process\.env\['DATABASE_URL'\]/,
    );
    assert.doesNotMatch(source, /resolveTestDatabaseUrl\(\)/);
  });

  void it('keeps the writer on TransactionContext without lifecycle or conflict suppression', async () => {
    const source = await readFile(
      path.join(eventsDir, 'outbox-writer.ts'),
      'utf8',
    );
    assert.match(source, /TransactionContext/);
    assert.match(source, /INSERT INTO outbox_events/);
    assert.doesNotMatch(source, /BEGIN/);
    assert.doesNotMatch(source, /COMMIT/);
    assert.doesNotMatch(source, /ROLLBACK/);
    assert.doesNotMatch(source, /pool\.connect/);
    assert.doesNotMatch(source, /fetch\(/);
    assert.doesNotMatch(source, /http\.request/);
    assert.doesNotMatch(source, /ON CONFLICT/i);
    assert.doesNotMatch(source, /console\./);
    assert.doesNotMatch(source, /JSON\.stringify\(event\.payload\)/);
  });

  void it('does not log or persist unexpected generic envelope fields', async () => {
    const files = await walk(eventsDir, false);
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const rel = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /initiatingMembershipId/, rel);
      assert.doesNotMatch(source, /actorId/, rel);
      assert.doesNotMatch(source, /session/, rel);
      assert.doesNotMatch(source, /Maintenance/, rel);
    }
  });

  void it('does not become a user-facing HTTP 4xx mapping', async () => {
    const source = await readFile(
      path.join(backendSrc, 'platform/http/errors.ts'),
      'utf8',
    );
    assert.doesNotMatch(source, /OutboxEventValidationError/);
    assert.doesNotMatch(source, /platform\/events/);
  });

  void it('leaves the transaction kernel outbox-free', async () => {
    const source = await readFile(
      path.join(backendSrc, 'platform/persistence/transaction.ts'),
      'utf8',
    );
    assert.doesNotMatch(source, /outbox/i);
    assert.doesNotMatch(source, /platform\/events/);
  });

  void it('does not add outbox writer types to frontend or shared', async () => {
    for (const dir of [
      path.join(repoRoot, 'frontend/src'),
      path.join(repoRoot, 'shared/src'),
    ]) {
      const files = await walk(dir, true);
      for (const file of files) {
        const source = await readFile(file, 'utf8');
        const rel = file.replaceAll('\\', '/');
        assert.doesNotMatch(source, /OutboxWriter/, rel);
        assert.doesNotMatch(source, /OutboxEventInput/, rel);
        assert.doesNotMatch(source, /outbox_events/, rel);
      }
    }
  });
});
