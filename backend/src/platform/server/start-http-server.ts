import type { Server } from 'node:http';
import type { Express } from 'express';
import { SHUTDOWN_TIMEOUT_MS } from '../http/constants.js';

export type ClosableResource = {
  close: () => Promise<unknown>;
};

export type StartHttpServerOptions = {
  app: Express;
  port: number;
  /** Persistence (and any other) resources closed after HTTP drain. */
  resources?: readonly ClosableResource[];
  /** Override for tests; defaults to process signal handlers once. */
  installSignalHandlers?: boolean;
  shutdownTimeoutMs?: number;
};

export type HttpServerRuntime = {
  server: Server;
  /** Initiate graceful shutdown (idempotent). */
  shutdown: (reason?: string) => Promise<void>;
};

/**
 * Bind the Express app to a TCP port and manage process lifecycle.
 * Kept separate from `createApp` so tests can exercise the app without listening.
 */
export function startHttpServer(
  options: StartHttpServerOptions,
): HttpServerRuntime {
  const {
    app,
    port,
    resources = [],
    installSignalHandlers = true,
    shutdownTimeoutMs = SHUTDOWN_TIMEOUT_MS,
  } = options;

  const server = app.listen(port);
  let shuttingDown = false;

  const shutdown = async (reason = 'shutdown'): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    // Content-free operational log (no secrets / request data).
    console.info(`[http] shutting down (${reason})`);

    const forceExit = setTimeout(() => {
      console.error('[http] shutdown timed out');
      process.exit(1);
    }, shutdownTimeoutMs);
    forceExit.unref();

    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

      for (const resource of resources) {
        await resource.close();
      }

      clearTimeout(forceExit);
      console.info('[http] shutdown complete');
    } catch (error) {
      clearTimeout(forceExit);
      console.error('[http] shutdown failed');
      throw error;
    }
  };

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

  server.on('listening', () => {
    console.info(`[http] listening on port ${port}`);
  });

  return { server, shutdown };
}
