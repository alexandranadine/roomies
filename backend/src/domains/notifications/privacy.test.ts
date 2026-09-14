import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { NotificationPersistenceError } from './errors.js';

const dir = path.dirname(fileURLToPath(import.meta.url));

void describe('Notification persistence privacy', () => {
  void it('does not persist protected Maintenance content, names, emails, or userId', async () => {
    const source = await readFile(path.join(dir, 'notification.ts'), 'utf8');
    assert.doesNotMatch(source, /user_id|userId/);
    assert.doesNotMatch(source, /\bmetadata\b|\bpayload\b/);
    assert.doesNotMatch(source, /\btitle\b|\bdetails\b|\baudience\b/);
    assert.doesNotMatch(source, /\bemail\b|displayName|actorName/);
  });

  void it('keeps insert SQL free of recipient userId and protected content', async () => {
    const source = await readFile(path.join(dir, 'repository.ts'), 'utf8');
    const insertAt = source.indexOf('export const INSERT_NOTIFICATION_SQL');
    const insertEnd = source.indexOf('`;', insertAt);
    const insertSql = source.slice(insertAt, insertEnd);
    assert.match(insertSql, /INSERT INTO notifications/);
    assert.doesNotMatch(insertSql, /user_id/);
    assert.doesNotMatch(insertSql, /title/);
    assert.doesNotMatch(insertSql, /details/);
    assert.doesNotMatch(insertSql, /audience/);
  });

  void it('keeps persistence errors free of protected source content', () => {
    const error = new NotificationPersistenceError();
    assert.equal(error.message, 'Notification persistence failure');
    assert.doesNotMatch(error.message, /title|details|audience|email|userId/);
  });
});
