import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const tasksDir = path.dirname(fileURLToPath(import.meta.url));

async function walk(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
      continue;
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

void describe('tasks domain boundary', () => {
  void it('does not import Membership or Home repository internals', async () => {
    const files = await walk(tasksDir);
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const rel = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /memberships\/repository/, rel);
      assert.doesNotMatch(source, /active-home-actor-lookup/, rel);
      assert.doesNotMatch(source, /homes\/repository/, rel);
      assert.doesNotMatch(source, /home-repository/, rel);
      assert.doesNotMatch(source, /home-administration/, rel);
    }
  });

  void it('keeps title and date rules free of persistence, HTTP, and JS Date', async () => {
    for (const name of ['task-title.ts', 'home-local-date.ts']) {
      const source = await readFile(path.join(tasksDir, name), 'utf8');
      assert.doesNotMatch(source, /from ['"]pg['"]/);
      assert.doesNotMatch(source, /from ['"]express['"]/);
      assert.doesNotMatch(source, /new Date\(/);
      assert.doesNotMatch(source, /Date\.UTC/);
      assert.doesNotMatch(source, /toISOString/);
      assert.doesNotMatch(source, /getTimezoneOffset/);
    }
  });

  void it('keeps repository Home-scoped and DATE-safe', async () => {
    const source = await readFile(path.join(tasksDir, 'repository.ts'), 'utf8');
    assert.match(source, /insertManual/);
    assert.match(source, /listByHome/);
    assert.match(source, /findByHomeAndId/);
    assert.match(source, /lockByHomeAndId/);
    assert.match(source, /completeOpenTask/);
    assert.match(source, /unassignOpenTasksForMembership/);
    assert.match(source, /unassignActiveDefinitionsForMembership/);
    assert.match(source, /insertDefinition/);
    assert.match(source, /listDefinitionsByHome/);
    assert.match(source, /lockDefinitionByHomeAndId/);
    assert.match(source, /deactivateActiveDefinition/);
    assert.match(source, /findNextDueDefinitionCandidate/);
    assert.match(source, /lockDueDefinitionByHomeAndId/);
    assert.match(source, /insertRecurringOccurrence/);
    assert.match(source, /advanceDefinitionCursor/);
    assert.match(source, /next_occurrence_date::text/);
    assert.match(source, /next_occurrence_date IS NOT NULL/);
    assert.match(source, /next_occurrence_at IS NOT NULL/);
    assert.match(source, /scheduled_for::text/);
    assert.match(source, /\$4::date/);
    assert.match(source, /'MANUAL'/);
    assert.match(source, /'OPEN'/);
    assert.match(source, /'COMPLETED'/);
    assert.match(source, /NULLS LAST/);
    assert.match(source, /FOR UPDATE/i);
    assert.match(source, /FOR UPDATE SKIP LOCKED/i);
    assert.match(
      source,
      /next_occurrence_at <= \$1::timestamptz[\s\S]*next_occurrence_at ASC,[\s\S]*next_occurrence_date ASC,[\s\S]*td\.id ASC/,
    );
    assert.match(
      source,
      /ON CONFLICT \(task_definition_id, scheduled_for\)[\s\S]*DO NOTHING/,
    );
    assert.match(source, /completed_at IS NULL/);
    assert.match(source, /UNASSIGN_OPEN_TASK_INSTANCES_FOR_MEMBERSHIP_SQL/);
    assert.match(source, /UNASSIGN_ACTIVE_TASK_DEFINITIONS_FOR_MEMBERSHIP_SQL/);
    assert.match(source, /home_id = \$1::uuid/);
    assert.match(source, /assigned_membership_id = \$2::uuid/);
    assert.match(source, /status = 'OPEN'/);
    assert.match(source, /deactivated_at IS NULL/);
    assert.doesNotMatch(source, /findById\(/);
    assert.doesNotMatch(source, /new Date\(/);
    assert.doesNotMatch(source, /Date\.UTC/);
    assert.doesNotMatch(source, /creator_membership_id =/);
    assert.doesNotMatch(source, /outbox/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /better-auth/);
    assert.doesNotMatch(source, /user_id/);
    assert.doesNotMatch(source, /home-administration/);
  });

  void it('keeps Task policies free of Home-read authz and Admin bypass', async () => {
    for (const name of [
      'create-policy.ts',
      'list-policy.ts',
      'complete-policy.ts',
      'definition-create-policy.ts',
      'definition-list-policy.ts',
      'definition-deactivate-policy.ts',
      'actions.ts',
    ]) {
      const source = await readFile(path.join(tasksDir, name), 'utf8');
      assert.doesNotMatch(source, /decideHomeRead/);
      assert.doesNotMatch(source, /isHomeAdmin/);
      assert.doesNotMatch(source, /from ['"]pg['"]/);
      assert.doesNotMatch(source, /from ['"]express['"]/);
      assert.doesNotMatch(source, /FOR UPDATE/i);
    }
    const actions = await readFile(path.join(tasksDir, 'actions.ts'), 'utf8');
    assert.match(actions, /task\.create/);
    assert.match(actions, /task\.list/);
    assert.match(actions, /task\.complete/);
    assert.match(actions, /task_definition\.create/);
    assert.match(actions, /task_definition\.list/);
    assert.match(actions, /task_definition\.deactivate/);
  });

  void it('keeps Task HTTP adapter-only on the existing Home authz path', async () => {
    const source = await readFile(path.join(tasksDir, 'http.ts'), 'utf8');
    assert.match(source, /router\.post\('\/:homeId\/tasks'/);
    assert.match(source, /router\.get\('\/:homeId\/tasks'/);
    assert.match(source, /router\.post\('\/:homeId\/tasks\/:taskId\/complete'/);
    assert.match(source, /router\.post\('\/:homeId\/task-definitions'/);
    assert.match(source, /router\.get\('\/:homeId\/task-definitions'/);
    assert.match(
      source,
      /router\.post\(\s*'\/:homeId\/task-definitions\/:taskDefinitionId\/deactivate'/,
    );
    assert.match(source, /createRequireHomeContext/);
    assert.match(source, /createRequireAuth/);
    assert.match(source, /setPrivateNoStoreHeaders/);
    assert.match(source, /\.strict\(\)/);
    assert.doesNotMatch(source, /lockHomeStructure/);
    assert.doesNotMatch(source, /FROM\s+task_instances/i);
    assert.doesNotMatch(source, /FROM\s+memberships/i);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /better-auth/);
    assert.doesNotMatch(source, /task\.created/);
    assert.doesNotMatch(source, /outbox/);
  });
});
