import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const persistenceDir = path.dirname(fileURLToPath(import.meta.url));
const backendSrc = path.resolve(persistenceDir, '../..');
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

void describe('transaction kernel boundary', () => {
  void it('does not import Better Auth, Express, or frontend/shared authority', async () => {
    const source = await readFile(
      path.join(persistenceDir, 'transaction.ts'),
      'utf8',
    );
    assert.doesNotMatch(source, /better-auth/);
    assert.doesNotMatch(source, /auth-runtime/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /frontend/);
    assert.doesNotMatch(source, /@roomies\/shared/);
    assert.doesNotMatch(source, /outbox_events/i);
    assert.doesNotMatch(source, /from ['"].*outbox/i);
    assert.doesNotMatch(source, /SERIALIZABLE/);
    assert.doesNotMatch(source, /pool\.end\(/);
    assert.doesNotMatch(source, /platform\/authz/);
    assert.doesNotMatch(source, /AuthorizationIntegrityError/);
  });

  void it('does not classify transaction lifecycle failures as authz errors', async () => {
    const files = ['transaction.ts', 'errors.ts'];
    for (const file of files) {
      const source = await readFile(path.join(persistenceDir, file), 'utf8');
      assert.doesNotMatch(source, /from ['"].*\/authz\//);
      assert.doesNotMatch(source, /AuthorizationIntegrityError/);
      assert.doesNotMatch(source, /StructuralIntegrityError/);
    }
  });

  void it('does not import domain or application orchestration', async () => {
    const files = await walk(persistenceDir);
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const rel = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /application\/home-administration/, rel);
      assert.doesNotMatch(source, /endMembershipWithinHomeStructure/, rel);
      assert.doesNotMatch(source, /from ['"].*\/domains\//, rel);
    }
  });

  void it('does not add Membership role to the auth session', async () => {
    const authFiles = await walk(path.join(backendSrc, 'platform/auth'));
    for (const file of authFiles) {
      const source = await readFile(file, 'utf8');
      const rel = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /membershipId/, rel);
      assert.doesNotMatch(source, /MembershipRole/, rel);
      assert.doesNotMatch(source, /primaryAdmin|Owner/, rel);
    }
  });

  void it('does not introduce Owner or a generic Admin bypass', async () => {
    const files = await walk(backendSrc);
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const rel = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /primaryAdmin/, rel);
      assert.doesNotMatch(source, /\bOwner\b/, rel);
    }
  });

  void it('does not add locked structural types to frontend or shared', async () => {
    for (const dir of [
      path.join(repoRoot, 'frontend/src'),
      path.join(repoRoot, 'shared/src'),
    ]) {
      const files = await walk(dir, true);
      for (const file of files) {
        const source = await readFile(file, 'utf8');
        const rel = file.replaceAll('\\', '/');
        assert.doesNotMatch(source, /LockedHomeStructure/, rel);
        assert.doesNotMatch(source, /lockHomeStructure/, rel);
        assert.doesNotMatch(source, /runInReadCommittedTransaction/, rel);
      }
    }
  });
});
