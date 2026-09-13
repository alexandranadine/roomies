import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createRecurrenceWorker,
  recurrenceFailureBackoffMs,
  type RecurrenceProcessResult,
  type RecurrenceWorkerLogFields,
  type RecurrenceWorkerLogger,
} from './recurrence-worker.js';

const idleResult: RecurrenceProcessResult = Object.freeze({
  definitionsProcessed: 0,
  occurrencesGenerated: 0,
  occurrencesReconciled: 0,
  moreDueWorkLikely: false,
});

const moreWorkResult: RecurrenceProcessResult = Object.freeze({
  definitionsProcessed: 25,
  occurrencesGenerated: 1,
  occurrencesReconciled: 0,
  moreDueWorkLikely: true,
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createRecordingLogger(): {
  logger: RecurrenceWorkerLogger;
  events: {
    level: 'info' | 'error';
    event: string;
    fields?: RecurrenceWorkerLogFields;
  }[];
} {
  const events: {
    level: 'info' | 'error';
    event: string;
    fields?: RecurrenceWorkerLogFields;
  }[] = [];
  return {
    events,
    logger: {
      info(event, fields) {
        events.push({ level: 'info', event, fields });
      },
      error(event, fields) {
        events.push({ level: 'error', event, fields });
      },
    },
  };
}

function createControllableSleep(): {
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  pending: { ms: number; resolve: () => void }[];
} {
  const pending: { ms: number; resolve: () => void }[] = [];
  return {
    pending,
    sleep(ms, signal) {
      return new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        const entry = {
          ms,
          resolve: () => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          },
        };
        const onAbort = () => {
          entry.resolve();
        };
        signal.addEventListener('abort', onAbort);
        pending.push(entry);
      });
    },
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1_000) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

void describe('recurrenceFailureBackoffMs', () => {
  void it('uses min(poll interval, 5s) then 1x 2x 4x 8x capped at 60s', () => {
    assert.equal(recurrenceFailureBackoffMs(1, 30_000), 5_000);
    assert.equal(recurrenceFailureBackoffMs(2, 30_000), 10_000);
    assert.equal(recurrenceFailureBackoffMs(3, 30_000), 20_000);
    assert.equal(recurrenceFailureBackoffMs(4, 30_000), 40_000);
    assert.equal(recurrenceFailureBackoffMs(5, 30_000), 60_000);
    assert.equal(recurrenceFailureBackoffMs(6, 30_000), 60_000);
    assert.equal(recurrenceFailureBackoffMs(1, 1_000), 1_000);
    assert.equal(recurrenceFailureBackoffMs(2, 1_000), 2_000);
    assert.equal(recurrenceFailureBackoffMs(3, 1_000), 4_000);
    assert.equal(recurrenceFailureBackoffMs(4, 1_000), 8_000);
  });
});

void describe('createRecurrenceWorker', () => {
  void it('invokes immediately on start rather than waiting one poll interval', async () => {
    const first = deferred<RecurrenceProcessResult>();
    let calls = 0;
    const { pending, sleep } = createControllableSleep();
    const worker = createRecurrenceWorker({
      pollIntervalMs: 30_000,
      sleep,
      yieldToEventLoop: () => Promise.resolve(),
      logger: createRecordingLogger().logger,
      process: async () => {
        calls += 1;
        return first.promise;
      },
    });

    worker.start();
    await waitFor(() => calls === 1, 'first invocation');
    assert.equal(pending.length, 0);
    first.resolve(idleResult);
    await waitFor(() => pending.length === 1, 'poll sleep');
    assert.equal(pending[0]?.ms, 30_000);
    await worker.stop();
  });

  void it('does not overlap invocations when a poll interval elapses during a slow run', async () => {
    const first = deferred<RecurrenceProcessResult>();
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const { pending, sleep } = createControllableSleep();
    const worker = createRecurrenceWorker({
      pollIntervalMs: 1_000,
      sleep,
      yieldToEventLoop: () => Promise.resolve(),
      logger: createRecordingLogger().logger,
      process: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        calls += 1;
        const result = await first.promise;
        inFlight -= 1;
        return result;
      },
    });

    worker.start();
    worker.start();
    await waitFor(() => calls === 1, 'single in-flight invocation');
    assert.equal(pending.length, 0);
    assert.equal(calls, 1);
    assert.equal(maxInFlight, 1);

    first.resolve(idleResult);
    await waitFor(() => pending.length === 1, 'sleep after first invocation');
    pending[0]?.resolve();
    await waitFor(() => calls === 2, 'second invocation after sleep');
    assert.equal(maxInFlight, 1);
    await worker.stop();
  });

  void it('drains immediately when moreDueWorkLikely is true, then resumes poll sleep', async () => {
    const results = [moreWorkResult, moreWorkResult, idleResult];
    let calls = 0;
    const yields: number[] = [];
    const { pending, sleep } = createControllableSleep();
    const worker = createRecurrenceWorker({
      pollIntervalMs: 30_000,
      sleep,
      yieldToEventLoop: () => {
        yields.push(calls);
        return Promise.resolve();
      },
      logger: createRecordingLogger().logger,
      process: () => {
        const result = results[calls];
        calls += 1;
        if (!result) {
          return Promise.reject(new Error('unexpected extra invocation'));
        }
        return Promise.resolve(result);
      },
    });

    worker.start();
    await waitFor(() => pending.length === 1, 'poll sleep after drain');
    assert.equal(calls, 3);
    assert.deepEqual(yields, [1, 2]);
    assert.equal(pending[0]?.ms, 30_000);
    await worker.stop();
  });

  void it('backs off consecutive failures and resets after success', async () => {
    const outcomes: Array<'fail' | RecurrenceProcessResult> = [
      'fail',
      'fail',
      idleResult,
      'fail',
    ];
    let calls = 0;
    const { pending, sleep } = createControllableSleep();
    const { logger, events } = createRecordingLogger();
    const worker = createRecurrenceWorker({
      pollIntervalMs: 30_000,
      sleep,
      yieldToEventLoop: () => Promise.resolve(),
      logger,
      process: () => {
        const outcome = outcomes[calls];
        calls += 1;
        if (outcome === 'fail') {
          return Promise.reject(new TypeError('transient'));
        }
        if (!outcome) {
          return Promise.resolve(idleResult);
        }
        return Promise.resolve(outcome);
      },
    });

    worker.start();
    await waitFor(() => pending.length === 1, 'first backoff');
    assert.equal(pending[0]?.ms, 5_000);
    pending.shift()?.resolve();
    await waitFor(() => pending.length === 1, 'second backoff');
    assert.equal(pending[0]?.ms, 10_000);
    pending.shift()?.resolve();
    await waitFor(() => pending.length === 1, 'poll sleep after success');
    assert.equal(pending[0]?.ms, 30_000);
    pending.shift()?.resolve();
    await waitFor(() => pending.length === 1, 'backoff after reset');
    assert.equal(pending[0]?.ms, 5_000);

    const failures = events.filter(
      (entry) => entry.event === 'invocation failed',
    );
    assert.equal(failures[0]?.fields?.consecutiveFailureCount, 1);
    assert.equal(failures[0]?.fields?.errorClass, 'TypeError');
    assert.equal(failures[1]?.fields?.consecutiveFailureCount, 2);
    assert.equal(failures[2]?.fields?.consecutiveFailureCount, 1);
    await worker.stop();
  });

  void it('exits promptly when shutdown occurs during backoff', async () => {
    let calls = 0;
    const { pending, sleep } = createControllableSleep();
    const worker = createRecurrenceWorker({
      pollIntervalMs: 30_000,
      sleep,
      yieldToEventLoop: () => Promise.resolve(),
      logger: createRecordingLogger().logger,
      process: () => {
        calls += 1;
        return Promise.reject(new Error('transient'));
      },
    });

    worker.start();
    await waitFor(() => pending.length === 1, 'backoff sleep');
    const stopping = worker.stop();
    await stopping;
    assert.equal(calls, 1);
  });

  void it('interrupts poll sleep and does not start another invocation', async () => {
    let calls = 0;
    const { pending, sleep } = createControllableSleep();
    const worker = createRecurrenceWorker({
      pollIntervalMs: 30_000,
      sleep,
      yieldToEventLoop: () => Promise.resolve(),
      logger: createRecordingLogger().logger,
      process: () => {
        calls += 1;
        return Promise.resolve(idleResult);
      },
    });

    worker.start();
    await waitFor(() => pending.length === 1, 'poll sleep');
    assert.equal(calls, 1);
    await worker.stop();
    assert.equal(calls, 1);
  });

  void it('waits for an in-flight invocation before exiting', async () => {
    const first = deferred<RecurrenceProcessResult>();
    let finished = false;
    let invocationStarted = false;
    const { sleep } = createControllableSleep();
    const worker = createRecurrenceWorker({
      pollIntervalMs: 30_000,
      sleep,
      yieldToEventLoop: () => Promise.resolve(),
      logger: createRecordingLogger().logger,
      process: async () => {
        invocationStarted = true;
        const result = await first.promise;
        finished = true;
        return result;
      },
    });

    worker.start();
    await waitFor(() => invocationStarted, 'in-flight invocation');
    const stopping = worker.stop();
    let stopSettled = false;
    void stopping.then(() => {
      stopSettled = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(stopSettled, false);
    assert.equal(finished, false);
    first.resolve(idleResult);
    await stopping;
    assert.equal(finished, true);
    assert.equal(stopSettled, true);
  });

  void it('does not start another drain iteration once stopping after moreDueWorkLikely', async () => {
    const first = deferred<RecurrenceProcessResult>();
    let calls = 0;
    let yielding = false;
    const yieldGate = deferred<void>();
    const { sleep } = createControllableSleep();
    const worker = createRecurrenceWorker({
      pollIntervalMs: 30_000,
      sleep,
      yieldToEventLoop: async () => {
        yielding = true;
        await yieldGate.promise;
      },
      logger: createRecordingLogger().logger,
      process: () => {
        calls += 1;
        return first.promise;
      },
    });

    worker.start();
    await waitFor(() => calls === 1, 'first drain invocation');
    first.resolve(moreWorkResult);
    await waitFor(() => yielding, 'cooperative yield');
    const stopping = worker.stop();
    yieldGate.resolve();
    await stopping;
    assert.equal(calls, 1);
  });

  void it('treats repeated stop as idempotent', async () => {
    const { pending, sleep } = createControllableSleep();
    const { logger, events } = createRecordingLogger();
    const worker = createRecurrenceWorker({
      pollIntervalMs: 30_000,
      sleep,
      yieldToEventLoop: () => Promise.resolve(),
      logger,
      process: () => Promise.resolve(idleResult),
    });

    worker.start();
    await waitFor(() => pending.length === 1, 'poll sleep');
    await worker.stop();
    await worker.stop();
    await worker.stop();
    assert.equal(
      events.filter((entry) => entry.event === 'shutting down').length,
      1,
    );
    assert.equal(
      events.filter((entry) => entry.event === 'worker stopped').length,
      1,
    );
  });

  void it('exits cleanly without retry when infrastructure is already closed', async () => {
    let closed = false;
    let calls = 0;
    const { pending, sleep } = createControllableSleep();
    const { logger, events } = createRecordingLogger();
    const worker = createRecurrenceWorker({
      pollIntervalMs: 30_000,
      sleep,
      yieldToEventLoop: () => Promise.resolve(),
      logger,
      isInfrastructureClosed: () => closed,
      process: () => {
        calls += 1;
        closed = true;
        return Promise.reject(
          new Error('Cannot use a pool after calling end on the pool'),
        );
      },
    });

    worker.start();
    await waitFor(() => calls === 1, 'closed-pool invocation');
    await waitFor(
      () => events.some((entry) => entry.event === 'worker stopped'),
      'clean loop exit',
    );
    assert.equal(pending.length, 0);
    assert.equal(
      events.filter((entry) => entry.event === 'invocation failed').length,
      0,
    );
    await worker.stop();
  });

  void it('logs only content-free operational fields', async () => {
    const { pending, sleep } = createControllableSleep();
    const { logger, events } = createRecordingLogger();
    const worker = createRecurrenceWorker({
      pollIntervalMs: 5_000,
      sleep,
      yieldToEventLoop: () => Promise.resolve(),
      logger,
      nowMs: () => 100,
      process: () =>
        Promise.resolve({
          definitionsProcessed: 2,
          occurrencesGenerated: 3,
          occurrencesReconciled: 1,
          moreDueWorkLikely: false,
        }),
    });

    worker.start();
    await waitFor(() => pending.length === 1, 'poll sleep');
    const completed = events.find(
      (entry) => entry.event === 'invocation completed',
    );
    assert.deepEqual(completed?.fields, {
      durationMs: 0,
      definitionsProcessed: 2,
      occurrencesGenerated: 3,
      occurrencesReconciled: 1,
      moreDueWorkLikely: false,
    });
    for (const entry of events) {
      const serialized = JSON.stringify(entry);
      assert.equal(serialized.includes('title'), false);
      assert.equal(serialized.includes('email'), false);
      assert.equal(serialized.includes('session'), false);
      assert.equal(serialized.includes('token'), false);
      assert.equal(serialized.includes('Maintenance'), false);
    }
    await worker.stop();
  });
});
