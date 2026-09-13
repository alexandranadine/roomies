import { decideTaskList } from '../../domains/tasks/list-policy.js';
import {
  createTaskRepository,
  type TaskRepository,
} from '../../domains/tasks/repository.js';
import type { TaskInstance } from '../../domains/tasks/task.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import type { TransactionPool } from '../../platform/persistence/transaction.js';

export type ListHomeTasksInput = Readonly<{
  actor: ActiveHomeActor;
  homeId: string;
}>;

/**
 * Authorized Home TaskInstance list. Renders from instance snapshots only.
 * Uses task.list. Does not take structural locks.
 */
export async function listHomeTasks(
  input: ListHomeTasksInput,
  tasks: Pick<TaskRepository, 'listByHome'>,
): Promise<readonly TaskInstance[]> {
  const decision = decideTaskList({
    actor: input.actor,
    targetHomeId: input.homeId,
  });
  if (!decision.allowed) {
    throw new ConcealedNotFoundError();
  }

  return tasks.listByHome(input.homeId);
}

export function createListHomeTasksFromPool(
  pool: TransactionPool,
): (input: ListHomeTasksInput) => Promise<readonly TaskInstance[]> {
  const tasks = createTaskRepository(
    pool as Parameters<typeof createTaskRepository>[0],
  );
  return (input) => listHomeTasks(input, tasks);
}
