import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const activityDir = path.dirname(fileURLToPath(import.meta.url));

async function productionFiles(): Promise<readonly string[]> {
  const entries = await readdir(activityDir, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts'),
    )
    .map((entry) => path.join(activityDir, entry.name));
}

void describe('activity domain boundary', () => {
  void it('does not import other domain repositories or sibling internals', async () => {
    for (const file of await productionFiles()) {
      const source = await readFile(file, 'utf8');
      const relative = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /domains\/homes\/repository/, relative);
      assert.doesNotMatch(source, /memberships\/repository/, relative);
      assert.doesNotMatch(source, /domains\/tasks/, relative);
      assert.doesNotMatch(source, /domains\/supplies/, relative);
      assert.doesNotMatch(source, /domains\/maintenance/, relative);
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
      if (!relative.endsWith('/http.ts')) {
        assert.doesNotMatch(source, /from ['"]express['"]/, relative);
      }
    }
  });

  void it('owns insertion primitives without independent recipient writes', async () => {
    const source = await readFile(
      path.join(activityDir, 'repository.ts'),
      'utf8',
    );
    for (const primitive of [
      'insertHomeVisibleActivity',
      'insertSourceAuthorizedActivity',
      'findBySourceOutboxEventId',
      'findVisibleByHomeAndId',
      'listVisibleByHome',
      'listVisiblePageByHome',
    ]) {
      assert.match(source, new RegExp(primitive));
    }
    assert.match(source, /ACTIVITY_ACTOR_SCOPE_SQL/);
    assert.match(source, /ACTIVITY_VISIBLE_PREDICATE_SQL/);
    assert.match(source, /LIST_VISIBLE_ACTIVITY_PAGE_SQL/);
    assert.match(source, /INSERT_ACTIVITY_RECIPIENT_SET_SQL/);
    assert.match(source, /ORDER BY u\.membership_id ASC/);
    assert.match(source, /activities_source_outbox_event_id_key_17bba872/);
    assert.match(source, /visibility_class = 'HOME_VISIBLE'/);
    assert.match(source, /visibility_class = 'SOURCE_AUTHORIZED'/);
    assert.doesNotMatch(source, /export async function insertRecipient/);
    assert.doesNotMatch(source, /addRecipient|updateRecipient|deleteRecipient/);
    assert.doesNotMatch(source, /INSERT_ACTIVITY_RECIPIENT_SQL =/);
    assert.doesNotMatch(source, /insertHomeVisibleActivity\([^)]*recipient/s);
    assert.doesNotMatch(source, /findById\(/);
    assert.doesNotMatch(source, /DELETE /i);
    assert.doesNotMatch(source, /console\.log/);
    assert.doesNotMatch(source, /CREATE TRIGGER/i);
    assert.doesNotMatch(source, /title|details|renderedText|actorName/);
    assert.doesNotMatch(source, /payload/);
  });

  void it('keeps Activity HTTP adapter-only on the existing Home authz path', async () => {
    const source = await readFile(path.join(activityDir, 'http.ts'), 'utf8');
    assert.match(source, /router\.get\('\/:homeId\/activity'/);
    assert.match(source, /createRequireAuth/);
    assert.match(source, /createRequireHomeContext/);
    assert.match(source, /setPrivateNoStoreHeaders/);
    assert.match(source, /listHomeActivity/);
    assert.match(source, /toActivityListPageDto/);
    assert.doesNotMatch(source, /createActivityRepository/);
    assert.doesNotMatch(source, /listVisiblePageByHome/);
    assert.doesNotMatch(source, /userId/);
    assert.doesNotMatch(source, /isHomeAdmin/);
    assert.doesNotMatch(source, /audience/);
    assert.doesNotMatch(source, /details/);
  });
});
