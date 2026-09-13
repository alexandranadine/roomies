import { decideTaskDefinitionList } from '../../domains/tasks/definition-list-policy.js';
import {
  createTaskRepository,
  type TaskRepository,
} from '../../domains/tasks/repository.js';
import type { TaskDefinition } from '../../domains/tasks/task-definition.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import type { TransactionPool } from '../../platform/persistence/transaction.js';

export type ListHomeTaskDefinitionsInput = Readonly<{
  actor: ActiveHomeActor;
  homeId: string;
}>;

/**
 * Authorized Home TaskDefinition list. Includes active and deactivated rows.
 * Uses task_definition.list. Does not take structural locks.
 */
export async function listHomeTaskDefinitions(
  input: ListHomeTaskDefinitionsInput,
  tasks: Pick<TaskRepository, 'listDefinitionsByHome'>,
): Promise<readonly TaskDefinition[]> {
  const decision = decideTaskDefinitionList({
    actor: input.actor,
    targetHomeId: input.homeId,
  });
  if (!decision.allowed) {
    throw new ConcealedNotFoundError();
  }

  return tasks.listDefinitionsByHome(input.homeId);
}

export function createListHomeTaskDefinitionsFromPool(
  pool: TransactionPool,
): (input: ListHomeTaskDefinitionsInput) => Promise<readonly TaskDefinition[]> {
  const tasks = createTaskRepository(
    pool as Parameters<typeof createTaskRepository>[0],
  );
  return (input) => listHomeTaskDefinitions(input, tasks);
}
