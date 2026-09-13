export const RECURRENCE_FAILURE_BACKOFF_BASE_CAP_MS = 5_000;
export const RECURRENCE_FAILURE_BACKOFF_MAX_MS = 60_000;

export type RecurrenceProcessResult = Readonly<{
  definitionsProcessed: number;
  occurrencesGenerated: number;
  occurrencesReconciled: number;
  moreDueWorkLikely: boolean;
}>;

export type RecurrenceProcess = () => Promise<RecurrenceProcessResult>;

export type RecurrenceWorkerSleep = (
  ms: number,
  signal: AbortSignal,
) => Promise<void>;

export type RecurrenceWorkerYield = () => Promise<void>;

export type RecurrenceWorkerLogFields = Readonly<{
  durationMs?: number;
  definitionsProcessed?: number;
  occurrencesGenerated?: number;
  occurrencesReconciled?: number;
  moreDueWorkLikely?: boolean;
  consecutiveFailureCount?: number;
  errorClass?: string;
  pollIntervalMs?: number;
}>;

export type RecurrenceWorkerLogger = {
  info(event: string, fields?: RecurrenceWorkerLogFields): void;
  error(event: string, fields?: RecurrenceWorkerLogFields): void;
};

export type RecurrenceWorkerDependencies = Readonly<{
  process: RecurrenceProcess;
  pollIntervalMs: number;
  sleep?: RecurrenceWorkerSleep;
  yieldToEventLoop?: RecurrenceWorkerYield;
  logger?: RecurrenceWorkerLogger;
  nowMs?: () => number;
  isInfrastructureClosed?: () => boolean;
}>;

export type RecurrenceWorkerRuntime = {
  start: () => void;
  stop: () => Promise<void>;
};

export function recurrenceFailureBackoffMs(
  consecutiveFailureCount: number,
  pollIntervalMs: number,
): number {
  const base = Math.min(pollIntervalMs, RECURRENCE_FAILURE_BACKOFF_BASE_CAP_MS);
  let delay = base;
  for (let step = 1; step < consecutiveFailureCount; step += 1) {
    delay = Math.min(delay * 2, RECURRENCE_FAILURE_BACKOFF_MAX_MS);
  }
  return delay;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort);
  });
}

export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

export function createConsoleRecurrenceLogger(): RecurrenceWorkerLogger {
  return {
    info(event, fields) {
      if (fields) {
        console.info(`[recurrence] ${event}`, fields);
        return;
      }
      console.info(`[recurrence] ${event}`);
    },
    error(event, fields) {
      if (fields) {
        console.error(`[recurrence] ${event}`, fields);
        return;
      }
      console.error(`[recurrence] ${event}`);
    },
  };
}

function errorClassOf(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) {
    return error.name;
  }
  return 'Error';
}

/**
 * Single-flight recurrence polling loop. Treats the injected process function
 * as a black box: one invocation at a time, abortable sleep, cooperative yield
 * between immediate drain iterations, bounded failure backoff.
 */
export function createRecurrenceWorker(
  deps: RecurrenceWorkerDependencies,
): RecurrenceWorkerRuntime {
  const sleep = deps.sleep ?? abortableSleep;
  const yieldToEventLoopImpl = deps.yieldToEventLoop ?? yieldToEventLoop;
  const logger = deps.logger ?? createConsoleRecurrenceLogger();
  const nowMs = deps.nowMs ?? (() => Date.now());
  const isInfrastructureClosed = deps.isInfrastructureClosed ?? (() => false);
  const controller = new AbortController();

  let started = false;
  let stopRequested = false;
  let loop: Promise<void> | undefined;

  async function runLoop(): Promise<void> {
    logger.info('worker started', { pollIntervalMs: deps.pollIntervalMs });
    let consecutiveFailureCount = 0;

    while (!controller.signal.aborted && !isInfrastructureClosed()) {
      const invocationStartedAt = nowMs();
      try {
        const result = await deps.process();
        consecutiveFailureCount = 0;
        logger.info('invocation completed', {
          durationMs: nowMs() - invocationStartedAt,
          definitionsProcessed: result.definitionsProcessed,
          occurrencesGenerated: result.occurrencesGenerated,
          occurrencesReconciled: result.occurrencesReconciled,
          moreDueWorkLikely: result.moreDueWorkLikely,
        });

        if (controller.signal.aborted || isInfrastructureClosed()) {
          break;
        }
        if (result.moreDueWorkLikely) {
          await yieldToEventLoopImpl();
          continue;
        }
        await sleep(deps.pollIntervalMs, controller.signal);
      } catch (error: unknown) {
        if (controller.signal.aborted || isInfrastructureClosed()) {
          break;
        }
        consecutiveFailureCount += 1;
        logger.error('invocation failed', {
          durationMs: nowMs() - invocationStartedAt,
          consecutiveFailureCount,
          errorClass: errorClassOf(error),
        });
        await sleep(
          recurrenceFailureBackoffMs(
            consecutiveFailureCount,
            deps.pollIntervalMs,
          ),
          controller.signal,
        );
      }
    }

    logger.info('worker stopped');
  }

  return {
    start() {
      if (started || stopRequested) {
        return;
      }
      started = true;
      loop = runLoop();
    },
    async stop() {
      if (stopRequested) {
        await loop;
        return;
      }
      stopRequested = true;
      logger.info('shutting down');
      controller.abort();
      await loop;
    },
  };
}
