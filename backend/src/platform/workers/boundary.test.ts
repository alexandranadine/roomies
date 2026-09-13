import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const workersDir = path.dirname(fileURLToPath(import.meta.url));
const backendSrc = path.resolve(workersDir, '../..');

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

void describe('recurrence worker boundary', () => {
  void it('treats the approved processor as a black box', async () => {
    const loop = await readFile(
      path.join(workersDir, 'recurrence-worker.ts'),
      'utf8',
    );
    const composition = await readFile(
      path.join(workersDir, 'create-recurrence-worker-from-pool.ts'),
      'utf8',
    );

    assert.match(composition, /createProcessDueRecurringTasksFromPool/);
    assert.doesNotMatch(loop, /createProcessDueRecurringTasks/);
    assert.doesNotMatch(loop, /computeNextRecurrenceCursor/);
    assert.doesNotMatch(loop, /maxDefinitions/);
    assert.doesNotMatch(loop, /maxOccurrencesPerDefinition/);
    assert.doesNotMatch(loop, /nextOccurrenceDate/);
    assert.doesNotMatch(loop, /setInterval/);
    assert.doesNotMatch(loop, /from ['"]pg['"]/);
    assert.doesNotMatch(loop, /from ['"]express['"]/);
    assert.doesNotMatch(loop, /pool\.end/);
    assert.doesNotMatch(loop, /outbox/);
    assert.doesNotMatch(composition, /from ['"]pg['"]/);
    assert.doesNotMatch(composition, /pool\.end/);
    assert.doesNotMatch(composition, /outbox/);
  });

  void it('does not log household or Maintenance content', async () => {
    const files = await walkProduction(workersDir);
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const rel = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /\btitle\b/, rel);
      assert.doesNotMatch(source, /\bemail\b/, rel);
      assert.doesNotMatch(source, /homeName|Home name/, rel);
      assert.doesNotMatch(source, /roommate/, rel);
      assert.doesNotMatch(source, /session/, rel);
      assert.doesNotMatch(source, /\btoken\b/, rel);
      assert.doesNotMatch(source, /requestId/, rel);
      assert.doesNotMatch(source, /Maintenance/, rel);
    }
  });

  void it('keeps Tasks application free of worker runtime', async () => {
    const files = await walkProduction(
      path.join(backendSrc, 'application/tasks'),
    );
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const rel = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /platform\/workers/, rel);
      assert.doesNotMatch(source, /platform\/runtime/, rel);
      assert.doesNotMatch(source, /PROCESS_MODE/, rel);
      assert.doesNotMatch(source, /createRecurrenceWorker/, rel);
    }
  });
});
