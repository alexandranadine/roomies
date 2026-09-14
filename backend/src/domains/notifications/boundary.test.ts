import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const notificationsDir = path.dirname(fileURLToPath(import.meta.url));

async function productionFiles(): Promise<readonly string[]> {
  const entries = await readdir(notificationsDir, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts'),
    )
    .map((entry) => path.join(notificationsDir, entry.name));
}

void describe('notification domain boundary', () => {
  void it('does not import other domain repositories or sibling internals', async () => {
    for (const file of await productionFiles()) {
      const source = await readFile(file, 'utf8');
      const relative = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /domains\/homes\/repository/, relative);
      assert.doesNotMatch(source, /memberships\/repository/, relative);
      assert.doesNotMatch(source, /domains\/tasks/, relative);
      assert.doesNotMatch(source, /domains\/supplies/, relative);
      assert.doesNotMatch(source, /domains\/maintenance/, relative);
      assert.doesNotMatch(source, /domains\/activity/, relative);
      assert.doesNotMatch(source, /home-administration/, relative);
      assert.doesNotMatch(source, /platform\/runtime/, relative);
      assert.doesNotMatch(source, /platform\/events/, relative);
      assert.doesNotMatch(
        source,
        /outbox-writer|outbox-types|outbox-validation/,
        relative,
      );
      assert.doesNotMatch(source, /better-auth/, relative);
      assert.doesNotMatch(source, /user_id/, relative);
      assert.doesNotMatch(source, /from ['"]express['"]/, relative);
    }
  });

  void it('owns insertion and cleanup primitives without list or read APIs', async () => {
    const source = await readFile(
      path.join(notificationsDir, 'repository.ts'),
      'utf8',
    );
    for (const primitive of [
      'insertNotification',
      'insertNotifications',
      'findBySourceRecipientKind',
      'deleteByRecipientMembership',
      'deleteBySource',
      'pruneExpired',
    ]) {
      assert.match(source, new RegExp(primitive));
    }
    assert.match(
      source,
      /NOTIFICATION_SOURCE_RECIPIENT_KIND_UNIQUE_CONSTRAINT/,
    );
    assert.match(source, /SAVEPOINT notification_insert/);
    assert.match(source, /duplicate_source_recipient_kind/);
    assert.match(source, /ORDER BY occurred_at ASC, id ASC/);
    assert.doesNotMatch(source, /listVisible|listEligible|markRead|readAll/);
    assert.doesNotMatch(source, /console\.log/);
    assert.doesNotMatch(source, /CREATE TRIGGER/i);
    assert.doesNotMatch(source, /title|details|audience|actorName/);
    assert.doesNotMatch(source, /payload|metadata|userId/);
    assert.doesNotMatch(source, /REFERENCES outbox_events/i);
  });
});
