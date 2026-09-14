import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decideNotificationList,
  decideNotificationMarkOne,
  decideNotificationReadAll,
} from './list-policy.js';

void describe('Notification current-user policy', () => {
  void it('allows list, mark-one, and read-all without a role or Admin grant', () => {
    assert.deepEqual(decideNotificationList(), { allowed: true });
    assert.deepEqual(decideNotificationMarkOne(), { allowed: true });
    assert.deepEqual(decideNotificationReadAll(), { allowed: true });
  });

  void it('does not inspect role, Admin, or Home scope', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./list-policy.ts', import.meta.url), 'utf8'),
    );
    assert.doesNotMatch(source, /ADMIN/);
    assert.doesNotMatch(source, /ROOMMATE/);
    assert.doesNotMatch(source, /homeId/);
    assert.doesNotMatch(source, /deny\(/);
  });
});
