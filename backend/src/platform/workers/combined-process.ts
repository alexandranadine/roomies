import type { DrainOutboxResult } from '../outbox/consumer.js';
import type {
  RecurrenceProcess,
  RecurrenceProcessResult,
} from './recurrence-worker.js';

export type OutboxDrain = (
  options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<DrainOutboxResult>;

const idleRecurrence: RecurrenceProcessResult = Object.freeze({
  definitionsProcessed: 0,
  occurrencesGenerated: 0,
  occurrencesReconciled: 0,
  moreDueWorkLikely: false,
});

/**
 * One worker invocation runs bounded recurrence work then bounded outbox
 * drain. Either side can report remaining work; neither is skipped when the
 * other is idle. Recurrence errors still run outbox before propagating so
 * outbox is not starved by recurrence failures.
 */
export function createCombinedWorkerProcess(deps: {
  processRecurrence: () => Promise<RecurrenceProcessResult>;
  drainOutbox: OutboxDrain;
}): RecurrenceProcess {
  return async (signal) => {
    let recurrenceResult = idleRecurrence;
    let recurrenceError: unknown;
    try {
      recurrenceResult = await deps.processRecurrence();
    } catch (error: unknown) {
      recurrenceError = error;
    }

    const outboxResult = await deps.drainOutbox(
      signal === undefined ? undefined : { signal },
    );

    if (recurrenceError instanceof Error) {
      throw recurrenceError;
    }
    if (recurrenceError !== undefined) {
      throw new Error('Recurrence processing failed');
    }

    return Object.freeze({
      definitionsProcessed: recurrenceResult.definitionsProcessed,
      occurrencesGenerated: recurrenceResult.occurrencesGenerated,
      occurrencesReconciled: recurrenceResult.occurrencesReconciled,
      moreDueWorkLikely:
        recurrenceResult.moreDueWorkLikely || outboxResult.moreWorkLikely,
    });
  };
}
