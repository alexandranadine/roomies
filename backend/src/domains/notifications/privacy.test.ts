import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { NotificationPersistenceError } from './errors.js';

const dir = path.dirname(fileURLToPath(import.meta.url));

async function productionFiles(): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts'),
    )
    .map((entry) => path.join(dir, entry.name));
}

void describe('Notification persistence privacy', () => {
  void it('does not persist protected Maintenance content, names, emails, or userId', async () => {
    for (const file of await productionFiles()) {
      const source = await readFile(file, 'utf8');
      const relative = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /user_id|userId/, relative);
      assert.doesNotMatch(source, /\bmetadata\b|\bpayload\b/, relative);
      assert.doesNotMatch(
        source,
        /\btitle\b|\bdetails\b|\baudience\b/,
        relative,
      );
      assert.doesNotMatch(source, /\bemail\b|displayName|actorName/, relative);
    }
  });

  void it('keeps persistence errors free of protected source content', () => {
    const error = new NotificationPersistenceError();
    assert.equal(error.message, 'Notification persistence failure');
    assert.doesNotMatch(error.message, /title|details|audience|email|userId/);
  });
});
