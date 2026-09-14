import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const pulseDir = path.dirname(fileURLToPath(import.meta.url));

async function productionFiles(): Promise<readonly string[]> {
  const entries = await readdir(pulseDir, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts'),
    )
    .map((entry) => path.join(pulseDir, entry.name));
}

void describe('pulse domain boundary', () => {
  void it('does not import sibling repositories or persistence SQL', async () => {
    for (const file of await productionFiles()) {
      const source = await readFile(file, 'utf8');
      const relative = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /tasks\/repository/, relative);
      assert.doesNotMatch(source, /supplies\/repository/, relative);
      assert.doesNotMatch(source, /maintenance\/repository/, relative);
      assert.doesNotMatch(source, /homes\/repository/, relative);
      assert.doesNotMatch(source, /memberships\/repository/, relative);
      assert.doesNotMatch(source, /from ['"]pg['"]/, relative);
      if (!relative.endsWith('/http.ts')) {
        assert.doesNotMatch(source, /from ['"]express['"]/, relative);
      }
    }
  });

  void it('keeps Pulse policy free of Home-read authz and Admin bypass', async () => {
    const source = await readFile(
      path.join(pulseDir, 'list-policy.ts'),
      'utf8',
    );
    assert.match(source, /decideHousePulseRead/);
    assert.match(source, /HOUSE_PULSE_READ_CAPABLE_ROLES/);
    assert.doesNotMatch(source, /decideHomeRead/);
    assert.doesNotMatch(source, /isHomeAdmin/);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /FOR UPDATE/i);
    const actions = await readFile(path.join(pulseDir, 'actions.ts'), 'utf8');
    assert.match(actions, /house_pulse\.read/);
  });

  void it('keeps Pulse HTTP adapter-only on the existing Home authz path', async () => {
    const source = await readFile(path.join(pulseDir, 'http.ts'), 'utf8');
    assert.match(source, /router\.get\('\/:homeId\/pulse'/);
    assert.match(source, /createRequireHomeContext/);
    assert.match(source, /createRequireAuth/);
    assert.match(source, /setPrivateNoStoreHeaders/);
    assert.match(source, /toHousePulseDto/);
    assert.doesNotMatch(source, /req\.body/);
    assert.doesNotMatch(source, /FROM\s+task_instances/i);
    assert.doesNotMatch(source, /FROM\s+memberships/i);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /better-auth/);
    assert.doesNotMatch(source, /ETag|etag/);
    assert.doesNotMatch(source, /router\.post/);
    assert.doesNotMatch(source, /router\.patch/);
  });

  void it('keeps the Pulse DTO free of identities, content, and scores', async () => {
    const source = await readFile(
      path.join(pulseDir, 'house-pulse-dto.ts'),
      'utf8',
    );
    assert.match(source, /housePulseDtoSchema/);
    assert.match(source, /\.strict\(\)/);
    assert.match(source, /generatedAt/);
    assert.match(source, /homeLocalDate/);
    assert.doesNotMatch(source, /membershipId/);
    assert.doesNotMatch(source, /userId/);
    assert.doesNotMatch(source, /title|details/);
    assert.doesNotMatch(source, /\bscore\b|\brank\b|\bblame\b|\bunread\b/);
    assert.doesNotMatch(source, /activity|notification/);
  });
});
