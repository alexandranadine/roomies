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
  void it('keeps domain event contracts typed against platform events only', async () => {
    const source = await readFile(path.join(homesDir, 'events.ts'), 'utf8');
    assert.match(source, /import type \{ OutboxEventInput \}/);
    assert.doesNotMatch(source, /from ['"].*\/http['"]/);
    assert.doesNotMatch(source, /home-dto/);
    assert.doesNotMatch(source, /better-auth/);
    assert.doesNotMatch(source, /auth-runtime/);
    assert.doesNotMatch(source, /session/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /createOutboxWriter/);
    assert.doesNotMatch(source, /email/);
    assert.doesNotMatch(source, /actorId/);
  });

  void it('keeps policies free of persistence and Express', async () => {
    const source = await readFile(path.join(homesDir, 'policies.ts'), 'utf8');
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /from ['"]@prisma\//);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /isHomeAdmin/);
    assert.doesNotMatch(source, /role\s*===\s*['"]ADMIN['"]/);
    assert.doesNotMatch(source, /FROM\s+memberships/i);
  });

  void it('keeps Home structural integrity errors free of authz ownership', async () => {
    const source = await readFile(
      path.join(homesDir, 'structure-errors.ts'),
      'utf8',
    );
    assert.doesNotMatch(source, /platform\/authz/);
    assert.doesNotMatch(source, /AuthorizationIntegrityError/);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /FOR UPDATE/i);
    assert.doesNotMatch(source, /FROM\s+/);
  });

  void it('keeps the structure invariant evaluator free of persistence and Express', async () => {
    const source = await readFile(
      path.join(homesDir, 'structure-invariant.ts'),
      'utf8',
    );
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /from ['"]@prisma\//);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /FOR UPDATE/i);
    assert.doesNotMatch(source, /better-auth/);
    assert.doesNotMatch(source, /AuthorizationIntegrityError/);
    assert.doesNotMatch(source, /platform\/authz\/errors/);
  });

  void it('keeps structural locking free of Express, Better Auth, and sibling writers', async () => {
    const source = await readFile(
      path.join(homesDir, 'lock-home-structure.ts'),
      'utf8',
    );
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /better-auth/);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /tasks?\//i);
    assert.doesNotMatch(source, /supplies?\//i);
    assert.doesNotMatch(source, /outbox/i);
    assert.doesNotMatch(source, /user_id\s*=\s*\$1/);
    assert.match(source, /FROM homes[\s\S]*FOR UPDATE[\s\S]*FROM memberships/i);
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

  void it('does not route Home reads through FOR UPDATE', async () => {
    const readFiles = [
      path.join(homesDir, 'get-home.ts'),
      path.join(homesDir, 'repository/home-repository.ts'),
      path.join(homesDir, 'http.ts'),
    ];
    for (const file of readFiles) {
      const source = await readFile(file, 'utf8');
      assert.doesNotMatch(source, /FOR UPDATE/i);
    }
  });

  void it('does not add structural mutation HTTP routes or FOR UPDATE reads', async () => {
    const source = await readFile(path.join(homesDir, 'http.ts'), 'utf8');
    assert.doesNotMatch(source, /router\.(post|patch|put|delete)\s*\(/);
    assert.doesNotMatch(source, /lockHomeStructure/);
    assert.doesNotMatch(source, /FOR UPDATE/i);
    assert.doesNotMatch(source, /leave|removeMember|archive/i);
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
