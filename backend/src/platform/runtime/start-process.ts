import { SHUTDOWN_TIMEOUT_MS } from '../http/constants.js';
import type { ClosableResource } from '../server/start-http-server.js';
import type { ProcessMode } from '../config/types.js';
import { startsHttpServer, startsRecurrenceWorker } from './process-mode.js';

export type ProcessHttpRuntime = {
  stopAccepting: () => Promise<void>;
};

export type ProcessWorkerRuntime = {
  start: () => void;
  stop: () => Promise<void>;
};

export type StartProcessOptions = {
  mode: ProcessMode;
  resources: readonly ClosableResource[];
  createHttp?: () => ProcessHttpRuntime;
  createWorker?: () => ProcessWorkerRuntime;
  installSignalHandlers?: boolean;
  shutdownTimeoutMs?: number;
};

export type ProcessRuntime = {
  shutdown: (reason?: string) => Promise<void>;
  http: ProcessHttpRuntime | undefined;
  worker: ProcessWorkerRuntime | undefined;
};

/**
 * Shared process lifecycle for web, worker, and combined modes.
 * Signal handling lives here; HTTP and the recurrence worker are optional
 * collaborators that do not own the shared PostgreSQL pool.
 */
export function startProcess(options: StartProcessOptions): ProcessRuntime {
  const {
    mode,
    resources,
    createHttp,
    createWorker,
    installSignalHandlers = true,
    shutdownTimeoutMs = SHUTDOWN_TIMEOUT_MS,
  } = options;

  if (startsHttpServer(mode) && createHttp === undefined) {
    throw new Error(
      'HTTP factory is required for web and combined process modes',
    );
  }
  if (startsRecurrenceWorker(mode) && createWorker === undefined) {
    throw new Error(
      'Worker factory is required for worker and combined process modes',
    );
  }

  let http: ProcessHttpRuntime | undefined;
  let worker: ProcessWorkerRuntime | undefined;
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (reason = 'shutdown'): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      console.info(`[process] shutting down (${reason})`);
      const forceExit = setTimeout(() => {
        console.error('[process] shutdown timed out');
        process.exit(1);
      }, shutdownTimeoutMs);
      forceExit.unref();

      try {
        const httpClosed = http?.stopAccepting() ?? Promise.resolve();
        await (worker?.stop() ?? Promise.resolve());
        await httpClosed;
        for (const resource of resources) {
          await resource.close();
        }
        clearTimeout(forceExit);
        console.info('[process] shutdown complete');
      } catch (error) {
        clearTimeout(forceExit);
        console.error('[process] shutdown failed');
        throw error;
      }
    })();

    return shutdownPromise;
  };

  try {
    if (startsRecurrenceWorker(mode) && createWorker) {
      worker = createWorker();
    }
    if (startsHttpServer(mode) && createHttp) {
      http = createHttp();
    }
    worker?.start();
  } catch (error) {
    void worker?.stop();
    void http?.stopAccepting();
    throw error;
  }

  if (installSignalHandlers) {
    const onSignal = (signal: NodeJS.Signals) => {
      void shutdown(signal)
        .then(() => {
          process.exit(0);
        })
        .catch(() => {
          process.exit(1);
        });
    };
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
  }

  return { shutdown, http, worker };
}
