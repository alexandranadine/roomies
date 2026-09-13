import { createProcessDueRecurringTasksFromPool } from '../../application/tasks/process-due-recurring-tasks.js';
import type { TransactionPool } from '../persistence/transaction.js';
import {
  createRecurrenceWorker,
  type RecurrenceWorkerRuntime,
} from './recurrence-worker.js';

/**
 * Compose the approved recurrence processor onto the process-owned pool.
 * The worker never creates or closes that pool.
 */
export function createRecurrenceWorkerFromPool(
  pool: TransactionPool,
  options: {
    pollIntervalMs: number;
    isInfrastructureClosed?: () => boolean;
  },
): RecurrenceWorkerRuntime {
  return createRecurrenceWorker({
    process: createProcessDueRecurringTasksFromPool(pool),
    pollIntervalMs: options.pollIntervalMs,
    isInfrastructureClosed: options.isInfrastructureClosed,
  });
}
