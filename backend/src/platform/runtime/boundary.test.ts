import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const backendSrc = path.resolve(runtimeDir, '../..');

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

void describe('process runtime boundary', () => {
  void it('owns mode switching without recurrence semantics or a second pool', async () => {
    const files = await walkProduction(runtimeDir);
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const rel = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /computeNextRecurrenceCursor/, rel);
      assert.doesNotMatch(source, /createProcessDueRecurringTasks/, rel);
      assert.doesNotMatch(source, /from ['"]pg['"]/, rel);
      assert.doesNotMatch(source, /new Pool/, rel);
      assert.doesNotMatch(source, /pool\.end/, rel);
      assert.doesNotMatch(source, /outbox/, rel);
      assert.doesNotMatch(source, /from ['"].*\/domains\//, rel);
    }
  });

  void it('wires process modes from the composition root', async () => {
    const source = await readFile(path.join(backendSrc, 'main.ts'), 'utf8');
    assert.match(source, /config\.processMode/);
    assert.match(source, /createRecurrenceWorkerFromPool/);
    assert.match(source, /startsHttpServer/);
    assert.match(source, /startsRecurrenceWorker/);
    assert.match(source, /startProcess/);
    assert.doesNotMatch(source, /createProcessDueRecurringTasks\(/);
    assert.doesNotMatch(source, /setInterval/);
  });

  void it('keeps signal handling out of the recurrence loop', async () => {
    const processSource = await readFile(
      path.join(runtimeDir, 'start-process.ts'),
      'utf8',
    );
    const workerSource = await readFile(
      path.join(backendSrc, 'platform/workers/recurrence-worker.ts'),
      'utf8',
    );
    assert.match(processSource, /SIGTERM/);
    assert.match(processSource, /SIGINT/);
    assert.doesNotMatch(workerSource, /SIGTERM/);
    assert.doesNotMatch(workerSource, /SIGINT/);
    assert.doesNotMatch(workerSource, /process\.once/);
  });
});
