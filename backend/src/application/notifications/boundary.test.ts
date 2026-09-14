import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const endingDir = path.join(dir, '../home-administration');

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

void describe('notifications application boundary', () => {
  void it('owns Membership-ending Notification cleanup without Home-administration internals', async () => {
    const cleanup = await readFile(
      path.join(dir, 'membership-ending-notification-cleanup.ts'),
      'utf8',
    );
    const composition = await readFile(
      path.join(endingDir, 'end-membership-within-home-structure.ts'),
      'utf8',
    );
    assert.match(cleanup, /createMembershipEndingNotificationCleanup/);
    assert.match(cleanup, /deleteByRecipientMembership/);
    assert.match(cleanup, /recipientMembershipId: input.membershipId/);
    assert.doesNotMatch(cleanup, /home-administration/);
    assert.doesNotMatch(cleanup, /memberships\/repository/);
    assert.doesNotMatch(cleanup, /homes\/repository/);
    assert.doesNotMatch(cleanup, /from ['"]pg['"]/);
    assert.doesNotMatch(cleanup, /Date\.now/);
    assert.doesNotMatch(cleanup, /new Date\(/);
    assert.doesNotMatch(cleanup, /clock/i);
    assert.doesNotMatch(cleanup, /outbox/);
    assert.doesNotMatch(cleanup, /BEGIN/);
    assert.doesNotMatch(cleanup, /COMMIT/);
    assert.doesNotMatch(cleanup, /runInReadCommittedTransaction/);
    assert.doesNotMatch(cleanup, /lockHomeStructure/);
    assert.doesNotMatch(cleanup, /userId/);
    assert.doesNotMatch(cleanup, /actorMembershipId/);
    assert.match(composition, /createEndMembershipWithinHomeStructureFromPool/);
    assert.match(
      composition,
      /createMembershipEndingNotificationCleanupFromPool/,
    );
    assert.doesNotMatch(composition, /notifications\/repository/);
    assert.doesNotMatch(composition, /FROM\s+notifications/i);
    assert.doesNotMatch(composition, /DELETE\s+FROM\s+notifications/i);
  });

  void it('exposes source erasure and retention without inventing Maintenance delete or a scheduler', async () => {
    const erasure = await readFile(
      path.join(dir, 'delete-notifications-for-source.ts'),
      'utf8',
    );
    const prune = await readFile(
      path.join(dir, 'prune-expired-notifications.ts'),
      'utf8',
    );
    assert.match(erasure, /deleteBySource/);
    assert.match(erasure, /sourceEntityType: 'MAINTENANCE'/);
    assert.doesNotMatch(erasure, /maintenance\/repository/);
    assert.doesNotMatch(erasure, /DELETE\s+FROM\s+maintenance/i);
    assert.doesNotMatch(erasure, /console\./);
    assert.match(prune, /NOTIFICATION_RETENTION_DAYS/);
    assert.match(prune, /NOTIFICATION_PRUNE_BATCH_SIZE/);
    assert.doesNotMatch(prune, /setInterval/);
    assert.doesNotMatch(prune, /platform\/workers/);
    assert.doesNotMatch(prune, /console\./);
    assert.doesNotMatch(prune, /title|details|audience/);
  });

  void it('does not import other domain repositories or Express', async () => {
    const files = await walkProduction(dir);
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const rel = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /memberships\/repository/, rel);
      assert.doesNotMatch(source, /homes\/repository/, rel);
      assert.doesNotMatch(source, /tasks\/repository/, rel);
      assert.doesNotMatch(source, /supplies\/repository/, rel);
      assert.doesNotMatch(source, /maintenance\/repository/, rel);
      assert.doesNotMatch(source, /activity\/repository/, rel);
      assert.doesNotMatch(source, /home-administration/, rel);
      assert.doesNotMatch(source, /from ['"]express['"]/, rel);
      assert.doesNotMatch(source, /better-auth/, rel);
      assert.doesNotMatch(source, /from ['"]pg['"]/, rel);
      assert.doesNotMatch(source, /console\./, rel);
      assert.doesNotMatch(source, /title|details|audience/, rel);
    }
  });

  void it('uses the global dispatcher, exact-tenure locks, and content-free persistence', async () => {
    const source = await readFile(path.join(dir, 'outbox-handler.ts'), 'utf8');
    assert.match(source, /NOTIFICATIONS_OUTBOX_HANDLER_ID = 'notifications'/);
    assert.match(source, /MEMBERSHIP_ROLE_CHANGED_V1/);
    assert.match(source, /TASK_COMPLETED_V1/);
    assert.match(source, /SUPPLY_OBTAINED_V1/);
    assert.match(source, /MAINTENANCE_CREATED_V1/);
    assert.match(source, /MAINTENANCE_RESOLVED_V1/);
    assert.match(source, /lockHomeAndExactMemberships/);
    assert.match(source, /recipientMembershipId/);
    assert.match(source, /sourceOutboxEventId/);
    assert.doesNotMatch(source, /runInReadCommittedTransaction|BEGIN|COMMIT/);
    assert.doesNotMatch(source, /userId|user_id/);
    assert.doesNotMatch(source, /title|details|audience|email|name/);
    assert.doesNotMatch(source, /isHomeAdmin|\brole\b/);
    assert.doesNotMatch(source, /console\./);
  });
});
