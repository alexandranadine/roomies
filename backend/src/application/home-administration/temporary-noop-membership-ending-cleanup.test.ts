import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

void describe('temporary no-op membership ending cleanup adapters', () => {
  void it('no longer ships a temporary Task no-op that production can select', async () => {
    await assert.rejects(
      () =>
        readFile(
          path.join(dir, 'temporary-noop-membership-ending-task-cleanup.ts'),
          'utf8',
        ),
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    );
  });

  void it('no longer ships a temporary Supply no-op that production can select', async () => {
    await assert.rejects(
      () =>
        readFile(
          path.join(dir, 'temporary-noop-membership-ending-supply-cleanup.ts'),
          'utf8',
        ),
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    );
  });
});
