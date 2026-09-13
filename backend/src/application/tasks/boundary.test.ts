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

  void it('completes Tasks through Home-first locks without assignee or outbox writes', async () => {
    const source = await readFile(path.join(dir, 'complete-task.ts'), 'utf8');
    assert.match(source, /decideTaskComplete/);
    assert.match(source, /lockHomeAndExactMemberships/);
    assert.match(source, /lockByHomeAndId/);
    assert.match(source, /completeOpenTask/);
    assert.match(source, /runInReadCommittedTransaction/);
    assert.match(source, /TaskAlreadyCompletedError/);
    assert.match(source, /userId/);
    assert.doesNotMatch(source, /decideHomeRead/);
    assert.doesNotMatch(source, /decideTaskList/);
    assert.doesNotMatch(source, /decideTaskCreate/);
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
    assert.doesNotMatch(source, /task\.completed\.v1/);
    assert.doesNotMatch(source, /SERIALIZABLE/);
    assert.doesNotMatch(source, /pg_advisory/i);
    assert.doesNotMatch(source, /user_id/);
    assert.doesNotMatch(source, /task_definitions/);
    assert.doesNotMatch(source, /reopenedAt/);
    assert.doesNotMatch(source, /completedBy/);
  });

  void it('creates recurring TaskDefinitions through locked Home timezone without instances or outbox', async () => {
    const source = await readFile(
      path.join(dir, 'create-recurring-task-definition.ts'),
      'utf8',
    );
    assert.match(source, /decideTaskDefinitionCreate/);
    assert.match(source, /lockHomeAndExactMemberships/);
    assert.match(source, /insertDefinition/);
    assert.match(source, /computeInitialRecurrenceCursor/);
    assert.match(source, /locked\.home\.timezone/);
    assert.match(source, /runInReadCommittedTransaction/);
    assert.match(source, /normalizeTaskTitle/);
    assert.match(source, /normalizeRecurrenceConfiguration/);
    assert.match(source, /creatorMembershipId: actor\.membershipId/);
    assert.doesNotMatch(source, /decideHomeRead/);
    assert.doesNotMatch(source, /findActiveHomeMembership/);
    assert.doesNotMatch(source, /memberships\/repository/);
    assert.doesNotMatch(source, /homes\/repository/);
    assert.doesNotMatch(source, /lockHomeStructure/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /Date\.now/);
    assert.doesNotMatch(source, /new Date\(/);
    assert.doesNotMatch(source, /outbox/);
    assert.doesNotMatch(source, /task_definition\.created/);
    assert.doesNotMatch(source, /insertManual/);
    assert.doesNotMatch(source, /SERIALIZABLE/);
    assert.doesNotMatch(source, /user_id/);
  });

  void it('lists Home TaskDefinitions through the public repository without joins', async () => {
    const source = await readFile(
      path.join(dir, 'list-home-task-definitions.ts'),
      'utf8',
    );
    assert.match(source, /decideTaskDefinitionList/);
    assert.match(source, /listDefinitionsByHome/);
    assert.doesNotMatch(source, /decideHomeRead/);
    assert.doesNotMatch(source, /memberships\/repository/);
    assert.doesNotMatch(source, /homes\/repository/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /outbox/);
    assert.doesNotMatch(source, /lockHomeStructure/);
    assert.doesNotMatch(source, /lockHomeAndExactMemberships/);
    assert.doesNotMatch(source, /FOR UPDATE/i);
    assert.doesNotMatch(source, /user_id/);
    assert.doesNotMatch(source, /email/);
  });

  void it('deactivates TaskDefinitions through exact creator-or-Admin without assignee locks', async () => {
    const source = await readFile(
      path.join(dir, 'deactivate-task-definition.ts'),
      'utf8',
    );
    assert.match(source, /decideTaskDefinitionDeactivate/);
    assert.match(source, /lockHomeAndExactMemberships/);
    assert.match(source, /lockDefinitionByHomeAndId/);
    assert.match(source, /deactivateActiveDefinition/);
    assert.match(source, /TaskDefinitionAlreadyDeactivatedError/);
    assert.match(source, /runInReadCommittedTransaction/);
    assert.doesNotMatch(source, /decideHomeRead/);
    assert.doesNotMatch(source, /isHomeAdmin/);
    assert.doesNotMatch(source, /assignedMembershipId/);
    assert.doesNotMatch(source, /memberships\/repository/);
    assert.doesNotMatch(source, /homes\/repository/);
    assert.doesNotMatch(source, /lockHomeStructure/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /Date\.now/);
    assert.doesNotMatch(source, /new Date\(/);
    assert.doesNotMatch(source, /outbox/);
    assert.doesNotMatch(source, /task_definition\.deactivated/);
    assert.doesNotMatch(source, /SERIALIZABLE/);
    assert.doesNotMatch(source, /user_id/);
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

  void it('owns Membership-ending Task cleanup without Home-administration internals', async () => {
    const cleanup = await readFile(
      path.join(dir, 'membership-ending-task-cleanup.ts'),
      'utf8',
    );
    const composition = await readFile(
      path.join(endingDir, 'end-membership-within-home-structure.ts'),
      'utf8',
    );
    assert.match(cleanup, /createMembershipEndingTaskCleanup/);
    assert.match(cleanup, /unassignOpenTasksForMembership/);
    assert.match(cleanup, /unassignActiveDefinitionsForMembership/);
    assert.match(cleanup, /updatedAt: input.endedAt/);
    assert.doesNotMatch(cleanup, /home-administration/);
    assert.doesNotMatch(cleanup, /memberships\/repository/);
    assert.doesNotMatch(cleanup, /homes\/repository/);
    assert.doesNotMatch(cleanup, /from ['"]pg['"]/);
    assert.doesNotMatch(cleanup, /Date\.now/);
    assert.doesNotMatch(cleanup, /new Date\(/);
    assert.doesNotMatch(cleanup, /clock/i);
    assert.doesNotMatch(cleanup, /outbox/);
    assert.doesNotMatch(cleanup, /task\.unassigned/);
    assert.doesNotMatch(cleanup, /BEGIN/);
    assert.doesNotMatch(cleanup, /COMMIT/);
    assert.doesNotMatch(cleanup, /runInReadCommittedTransaction/);
    assert.doesNotMatch(cleanup, /lockHomeStructure/);
    assert.doesNotMatch(cleanup, /lockHomeAndExactMemberships/);
    assert.match(composition, /createEndMembershipWithinHomeStructureFromPool/);
    assert.match(composition, /createMembershipEndingTaskCleanupFromPool/);
    assert.doesNotMatch(
      composition,
      /createTemporaryNoOpMembershipEndingTaskCleanup/,
    );
    assert.doesNotMatch(composition, /tasks\/repository/);
    assert.doesNotMatch(composition, /FROM\s+task_instances/i);
    assert.doesNotMatch(composition, /FROM\s+task_definitions/i);
  });
});
