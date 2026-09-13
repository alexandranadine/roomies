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
});
