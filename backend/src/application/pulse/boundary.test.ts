import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

async function walkProduction(root: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkProduction(full)));
      continue;
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

void describe('pulse application boundary', () => {
  void it('orchestrates Pulse through public ports in one REPEATABLE READ', async () => {
    const source = await readFile(path.join(dir, 'get-house-pulse.ts'), 'utf8');
    assert.match(source, /decideHousePulseRead/);
    assert.match(source, /findHousePulseSnapshot/);
    assert.match(source, /findTaskPulseSummary/);
    assert.match(source, /findSupplyPulseSummary/);
    assert.match(source, /findMaintenancePulseSummary/);
    assert.match(source, /homeLocalDateFromInstant/);
    assert.match(source, /runInRepeatableReadTransaction/);
    assert.match(
      source,
      /actorMembershipId: input\.actor\.membershipId|requesterMembershipId: input\.actor\.membershipId/,
    );
    assert.match(source, /ConcealedNotFoundError/);
    assert.match(source, /housePulseSectionState/);
    const factory = source.slice(source.indexOf('createGetHousePulseFromPool'));
    assert.doesNotMatch(factory, /afterTaskSummary/);
    assert.doesNotMatch(source, /decideHomeRead/);
    assert.doesNotMatch(source, /isHomeAdmin/);
    assert.doesNotMatch(source, /tasks\/repository/);
    assert.doesNotMatch(source, /supplies\/repository/);
    assert.doesNotMatch(source, /maintenance\/repository/);
    assert.doesNotMatch(source, /homes\/repository/);
    assert.doesNotMatch(source, /memberships\/repository/);
    assert.doesNotMatch(source, /activity\/repository/);
    assert.doesNotMatch(source, /notifications\/repository/);
    assert.doesNotMatch(source, /listByHome/);
    assert.doesNotMatch(source, /listOpenEntriesByHome/);
    assert.doesNotMatch(source, /listVisibleByHome/);
    assert.doesNotMatch(source, /SERIALIZABLE/);
    assert.doesNotMatch(source, /FOR UPDATE/i);
    assert.doesNotMatch(source, /Date\.now/);
    assert.doesNotMatch(source, /new Date\(/);
    assert.doesNotMatch(source, /toLocaleDateString/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /outbox/);
    assert.doesNotMatch(source, /Redis|redis/);
    assert.doesNotMatch(source, /userId/);
  });

  void it('does not import sibling repository internals or HTTP', async () => {
    for (const file of await walkProduction(dir)) {
      const source = await readFile(file, 'utf8');
      const rel = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /maintenance\/repository/, rel);
      assert.doesNotMatch(source, /memberships\/repository/, rel);
      assert.doesNotMatch(source, /homes\/repository/, rel);
      assert.doesNotMatch(source, /tasks\/repository/, rel);
      assert.doesNotMatch(source, /supplies\/repository/, rel);
      assert.doesNotMatch(source, /from ['"]express['"]/, rel);
      assert.doesNotMatch(source, /better-auth/, rel);
      assert.doesNotMatch(source, /from ['"]pg['"]/, rel);
    }
  });
});
