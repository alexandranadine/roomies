import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCombinedWorkerProcess } from './combined-process.js';
import type { RecurrenceProcessResult } from './recurrence-worker.js';

const idle: RecurrenceProcessResult = Object.freeze({
  definitionsProcessed: 0,
  occurrencesGenerated: 0,
  occurrencesReconciled: 0,
  moreDueWorkLikely: false,
});

void describe('createCombinedWorkerProcess', () => {
  void it('ORs moreWorkLikely and runs both sides each invocation', async () => {
    let recurrenceCalls = 0;
    let outboxCalls = 0;
    const process = createCombinedWorkerProcess({
      processRecurrence: () => {
        recurrenceCalls += 1;
        return Promise.resolve({
          definitionsProcessed: 1,
          occurrencesGenerated: 2,
          occurrencesReconciled: 0,
          moreDueWorkLikely: false,
        });
      },
      drainOutbox: () => {
        outboxCalls += 1;
        return Promise.resolve({
          processedCount: 3,
          failedCount: 0,
          moreWorkLikely: true,
        });
      },
    });

    const result = await process();
    assert.equal(recurrenceCalls, 1);
    assert.equal(outboxCalls, 1);
    assert.deepEqual(result, {
      definitionsProcessed: 1,
      occurrencesGenerated: 2,
      occurrencesReconciled: 0,
      moreDueWorkLikely: true,
    });
  });

  void it('still drains outbox when recurrence reports idle', async () => {
    const process = createCombinedWorkerProcess({
      processRecurrence: () => Promise.resolve(idle),
      drainOutbox: () =>
        Promise.resolve({
          processedCount: 1,
          failedCount: 0,
          moreWorkLikely: false,
        }),
    });
    const result = await process();
    assert.equal(result.moreDueWorkLikely, false);
    assert.equal(result.definitionsProcessed, 0);
  });

  void it('drains outbox before propagating a recurrence error', async () => {
    let drained = false;
    const process = createCombinedWorkerProcess({
      processRecurrence: () => Promise.reject(new Error('recurrence failed')),
      drainOutbox: () => {
        drained = true;
        return Promise.resolve({
          processedCount: 1,
          failedCount: 0,
          moreWorkLikely: false,
        });
      },
    });
    await assert.rejects(process(), /recurrence failed/);
    assert.equal(drained, true);
  });

  void it('forwards the abort signal only to outbox drain', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const process = createCombinedWorkerProcess({
      processRecurrence: () => Promise.resolve(idle),
      drainOutbox: (options) => {
        seen = options?.signal;
        return Promise.resolve({
          processedCount: 0,
          failedCount: 0,
          moreWorkLikely: false,
        });
      },
    });
    await process(controller.signal);
    assert.equal(seen, controller.signal);
  });
});
