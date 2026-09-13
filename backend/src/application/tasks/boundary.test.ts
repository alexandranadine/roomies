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

void describe('tasks application boundary', () => {
  void it('creates manual Tasks without repository internals, locks, or outbox', async () => {
    const source = await readFile(
      path.join(dir, 'create-manual-task.ts'),
      'utf8',
    );
    assert.match(source, /decideTaskCreate/);
    assert.match(source, /lockHomeAndExactMemberships/);
    assert.match(source, /insertManual/);
    assert.match(source, /runInReadCommittedTransaction/);
    assert.match(source, /normalizeTaskTitle/);
    assert.match(source, /parseHomeLocalDate/);
    assert.match(source, /userId/);
    assert.doesNotMatch(source, /decideHomeRead/);
    assert.doesNotMatch(source, /findActiveHomeMembership/);
    assert.doesNotMatch(source, /memberships\/repository/);
    assert.doesNotMatch(source, /homes\/repository/);
    assert.doesNotMatch(source, /home-repository/);
    assert.doesNotMatch(source, /active-home-actor-lookup/);
    assert.doesNotMatch(source, /lockHomeStructure/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /better-auth/);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /Date\.now/);
    assert.doesNotMatch(source, /new Date\(/);
    assert.doesNotMatch(source, /outbox/);
    assert.doesNotMatch(source, /task\.created/);
    assert.doesNotMatch(source, /SERIALIZABLE/);
    assert.doesNotMatch(source, /pg_advisory/i);
    assert.doesNotMatch(source, /user_id/);
    assert.doesNotMatch(source, /taskDefinitionId/);
    assert.doesNotMatch(source, /completedAt/);
  });

  void it('lists Home Tasks through the public repository without definition joins', async () => {
    const source = await readFile(path.join(dir, 'list-home-tasks.ts'), 'utf8');
    assert.match(source, /decideTaskList/);
    assert.match(source, /listByHome/);
    assert.doesNotMatch(source, /decideHomeRead/);
    assert.doesNotMatch(source, /task_definitions/);
    assert.doesNotMatch(source, /memberships\/repository/);
    assert.doesNotMatch(source, /homes\/repository/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /better-auth/);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /outbox/);
    assert.doesNotMatch(source, /lockHomeStructure/);
    assert.doesNotMatch(source, /lockHomeAndExactMemberships/);
    assert.doesNotMatch(source, /FOR UPDATE/i);
  });

  void it('does not import repository internals or Express', async () => {
    const files = await walkProduction(dir);
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const rel = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /memberships\/repository/, rel);
      assert.doesNotMatch(source, /homes\/repository/, rel);
      assert.doesNotMatch(source, /from ['"]express['"]/, rel);
      assert.doesNotMatch(source, /better-auth/, rel);
      assert.doesNotMatch(source, /from ['"]pg['"]/, rel);
    }
  });

  void it('leaves Membership-ending Task cleanup as the temporary no-op', async () => {
    const cleanup = await readFile(
      path.join(endingDir, 'temporary-noop-membership-ending-task-cleanup.ts'),
      'utf8',
    );
    const composition = await readFile(
      path.join(endingDir, 'end-membership-within-home-structure.ts'),
      'utf8',
    );
    assert.match(cleanup, /TEMPORARY no-op Task cleanup/);
    assert.match(
      composition,
      /createEndMembershipWithinHomeStructureWithTemporaryNoOpCleanup/,
    );
    assert.doesNotMatch(cleanup, /task_instances/);
    assert.doesNotMatch(cleanup, /assigned_membership_id/);
    assert.doesNotMatch(composition, /createTaskRepository/);
    assert.doesNotMatch(composition, /unassign/);
  });
});
