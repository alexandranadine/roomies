import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  LIST_ELIGIBLE_NOTIFICATION_PAGE_SQL,
  READ_ALL_ELIGIBLE_UNREAD_SQL,
} from './repository.js';

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
      if (
        !relative.endsWith('/repository.ts') &&
        !relative.endsWith('/cursor.ts') &&
        !relative.endsWith('/http.ts')
      ) {
        assert.doesNotMatch(source, /user_id/, relative);
        assert.doesNotMatch(source, /userId/, relative);
      }
      if (!relative.endsWith('/http.ts')) {
        assert.doesNotMatch(source, /from ['"]express['"]/, relative);
      }
    }
  });

  void it('owns insertion, cleanup, and visibility-shaped read primitives', async () => {
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
      'listEligiblePageForUser',
      'markEligibleRead',
      'readAllEligibleUnread',
      'findActiveRecipientTenures',
      'readTransactionTimestamp',
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
    assert.match(source, /LIST_ELIGIBLE_NOTIFICATION_PAGE_SQL/);
    assert.match(source, /MARK_ELIGIBLE_NOTIFICATION_READ_SQL/);
    assert.match(source, /READ_ALL_ELIGIBLE_UNREAD_SQL/);
    assert.match(source, /n\.created_at <= \$2::timestamptz/);
    assert.match(source, /error\.code === '40001'/);
    assert.doesNotMatch(source, /findAllNotificationsForUser/);
    assert.doesNotMatch(source, /n\.occurred_at <= \$2/);
    assert.doesNotMatch(source, /console\.log/);
    assert.doesNotMatch(source, /CREATE TRIGGER/i);
    assert.doesNotMatch(source, /actorName/);
    assert.doesNotMatch(source, /payload|metadata/);
    assert.doesNotMatch(source, /REFERENCES outbox_events/i);
    assert.doesNotMatch(source, /isHomeAdmin/);
    assert.doesNotMatch(LIST_ELIGIBLE_NOTIFICATION_PAGE_SQL, /\bADMIN\b/);
    assert.doesNotMatch(READ_ALL_ELIGIBLE_UNREAD_SQL, /\bADMIN\b/);
  });

  void it('keeps Notification HTTP adapter-only on the current-user auth path', async () => {
    const source = await readFile(
      path.join(notificationsDir, 'http.ts'),
      'utf8',
    );
    assert.match(source, /router\.get\('\/'/);
    assert.match(source, /router\.post\('\/read-all'/);
    assert.match(source, /router\.post\('\/:notificationId\/read'/);
    assert.match(source, /createRequireAuth/);
    assert.match(source, /setPrivateNoStoreHeaders/);
    assert.match(source, /listCurrentUserNotifications/);
    assert.match(source, /markNotificationRead/);
    assert.match(source, /readAllNotifications/);
    assert.match(source, /toNotificationListPageDto/);
    assert.doesNotMatch(source, /createRequireHomeContext/);
    assert.doesNotMatch(source, /createNotificationRepository/);
    assert.doesNotMatch(source, /listEligiblePageForUser/);
    assert.doesNotMatch(source, /isHomeAdmin/);
    assert.doesNotMatch(source, /audience/);
    assert.doesNotMatch(source, /details/);
  });
});
