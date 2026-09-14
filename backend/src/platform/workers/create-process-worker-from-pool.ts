import { createActivityOutboxHandlerFromPool } from '../../application/activity/outbox-handler.js';
import { createProcessDueRecurringTasksFromPool } from '../../application/tasks/process-due-recurring-tasks.js';
import {
  createOutboxConsumerFromPool,
  createOutboxHandlerRegistry,
  type OutboxHandlerRegistry,
} from '../outbox/index.js';
import type { TransactionPool } from '../persistence/transaction.js';
import { createCombinedWorkerProcess } from './combined-process.js';
import {
  createRecurrenceWorker,
  type RecurrenceWorkerRuntime,
} from './recurrence-worker.js';

/**
 * Compose recurrence processing and generic outbox drain onto the
 * process-owned pool. The worker never creates or closes that pool.
 * Production registers the Activity outbox handler on this dispatcher.
 */
export function createProcessWorkerFromPool(
  pool: TransactionPool,
  options: {
    pollIntervalMs: number;
    isInfrastructureClosed?: () => boolean;
    outboxRegistry?: OutboxHandlerRegistry;
  },
): RecurrenceWorkerRuntime {
  const registry =
    options.outboxRegistry ??
    createOutboxHandlerRegistry([createActivityOutboxHandlerFromPool(pool)]);
  const outbox = createOutboxConsumerFromPool(pool, { registry });

  return createRecurrenceWorker({
    process: createCombinedWorkerProcess({
      processRecurrence: () => createProcessDueRecurringTasksFromPool(pool)(),
      drainOutbox: (drainOptions) => outbox.drain(drainOptions),
    }),
    pollIntervalMs: options.pollIntervalMs,
    isInfrastructureClosed: options.isInfrastructureClosed,
  });
}
