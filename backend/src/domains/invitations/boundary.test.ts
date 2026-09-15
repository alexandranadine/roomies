import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const invitationsDir = path.dirname(fileURLToPath(import.meta.url));

void describe('invitations domain boundary', () => {
  void it('contains no HTTP, Better Auth, command, or event implementation', async () => {
    const names = await readdir(invitationsDir);
    for (const name of names.filter(
      (value) => value.endsWith('.ts') && !value.endsWith('.test.ts'),
    )) {
      const source = await readFile(path.join(invitationsDir, name), 'utf8');
      assert.doesNotMatch(source, /from ['"]express['"]/, name);
      assert.doesNotMatch(source, /from ['"]better-auth/, name);
      assert.doesNotMatch(source, /from ['"]@better-auth\//, name);
      assert.doesNotMatch(source, /\brouter\./, name);
      assert.doesNotMatch(source, /\boutbox_events\b/, name);
      assert.doesNotMatch(source, /\buser_id\b/i, name);
    }
  });

  void it('keeps home-archive cleanup on persistence without outbox or a clock read', async () => {
    const source = await readFile(
      path.join(invitationsDir, 'home-archive-cleanup.ts'),
      'utf8',
    );
    assert.match(source, /lockEffectivePendingForHomeArchive/);
    assert.match(source, /revokeLocked/);
    assert.match(source, /projectInvitationLifecycle/);
    assert.match(source, /HOME_ARCHIVED/);
    assert.doesNotMatch(source, /Date\.now/);
    assert.doesNotMatch(source, /outbox/);
    assert.doesNotMatch(source, /invitation\.revoked/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /BEGIN/);
    assert.doesNotMatch(source, /COMMIT/);
    assert.doesNotMatch(source, /runInReadCommittedTransaction/);
  });

  void it('keeps target-email erasure on invitation persistence without locks or auth discovery', async () => {
    const source = await readFile(
      path.join(invitationsDir, 'erase-invitations-for-target-email.ts'),
      'utf8',
    );
    assert.match(source, /lockByInvitedEmailForErase/);
    assert.match(source, /deleteLockedForTargetEmailErase/);
    assert.match(source, /normalizeEmail/);
    assert.match(source, /invitedEmail/);
    assert.doesNotMatch(source, /runInReadCommittedTransaction/);
    assert.doesNotMatch(source, /BEGIN/);
    assert.doesNotMatch(source, /COMMIT/);
    assert.doesNotMatch(source, /auth_identities/);
    assert.doesNotMatch(source, /findCurrentCanonicalIdentity/);
    assert.doesNotMatch(source, /lockCanonicalUser/);
    assert.doesNotMatch(source, /lockHomeStructure/);
    assert.doesNotMatch(source, /lockHomeAndExactMemberships/);
    assert.doesNotMatch(source, /createdByMembershipId/);
    assert.doesNotMatch(source, /created_by_membership_id/);
    assert.doesNotMatch(source, /userId/);
    assert.doesNotMatch(source, /user_id/);
    assert.doesNotMatch(source, /outbox/);
    assert.doesNotMatch(source, /activity/);
    assert.doesNotMatch(source, /notification/i);
    assert.doesNotMatch(source, /console\./);
    assert.doesNotMatch(source, /Date\.now/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /memberships\/repository/);
    assert.doesNotMatch(source, /homes\/repository/);
  });

  void it('locks target-email erase rows by invited_email in id order', async () => {
    const source = await readFile(
      path.join(invitationsDir, 'repository.ts'),
      'utf8',
    );
    assert.match(source, /LOCK_INVITATIONS_FOR_TARGET_EMAIL_ERASE_SQL/);
    assert.match(source, /DELETE_INVITATIONS_FOR_TARGET_EMAIL_ERASE_SQL/);
    assert.match(source, /lockByInvitedEmailForErase/);
    assert.match(source, /deleteLockedForTargetEmailErase/);
    assert.match(
      source,
      /export const LOCK_INVITATIONS_FOR_TARGET_EMAIL_ERASE_SQL = `\s*SELECT id, home_id\s*FROM invitations\s*WHERE invited_email = \$1::text\s*ORDER BY id ASC\s*FOR UPDATE\s*`;/,
    );
    assert.match(
      source,
      /export const DELETE_INVITATIONS_FOR_TARGET_EMAIL_ERASE_SQL = `\s*DELETE FROM invitations\s*WHERE id = ANY\(\$1::uuid\[\]\)\s*`;/,
    );
  });
});
