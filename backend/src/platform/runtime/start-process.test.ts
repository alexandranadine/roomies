import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import express from 'express';
import type { Server } from 'node:http';
import { startHttpServer } from '../server/start-http-server.js';
import { startsHttpServer, startsRecurrenceWorker } from './process-mode.js';
import { startProcess, type ProcessWorkerRuntime } from './start-process.js';

void describe('process mode helpers', () => {
  void it('maps web, worker, and combined to HTTP and recurrence workers', () => {
    assert.equal(startsHttpServer('web'), true);
    assert.equal(startsRecurrenceWorker('web'), false);
    assert.equal(startsHttpServer('worker'), false);
    assert.equal(startsRecurrenceWorker('worker'), true);
    assert.equal(startsHttpServer('combined'), true);
    assert.equal(startsRecurrenceWorker('combined'), true);
  });
});

void describe('startProcess lifecycle', () => {
  void it('fails before starting when a required factory is missing', () => {
    assert.throws(
      () =>
        startProcess({
          mode: 'web',
          resources: [],
          installSignalHandlers: false,
        }),
      /HTTP factory is required/,
    );
    assert.throws(
      () =>
        startProcess({
          mode: 'worker',
          resources: [],
          installSignalHandlers: false,
        }),
      /Worker factory is required/,
    );
  });

  let server: Server | undefined;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
    }
    server = undefined;
  });

  function recordingResource() {
    let closeCount = 0;
    return {
      get closeCount() {
        return closeCount;
      },
      close: () => {
        closeCount += 1;
        return Promise.resolve();
      },
    };
  }

  function recordingWorker(): ProcessWorkerRuntime & {
    started: boolean;
    stopCount: number;
    stopped: Promise<void>;
    releaseStop: () => void;
  } {
    let started = false;
    let stopCount = 0;
    let release!: () => void;
    const stopped = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      get started() {
        return started;
      },
      get stopCount() {
        return stopCount;
      },
      stopped,
      releaseStop: () => {
        release();
      },
      start() {
        started = true;
      },
      async stop() {
        stopCount += 1;
        await stopped;
      },
    };
  }

  void it('starts HTTP only in web mode', async () => {
    const resource = recordingResource();
    const runtime = startProcess({
      mode: 'web',
      resources: [resource],
      installSignalHandlers: false,
      createHttp: () => {
        const http = startHttpServer({
          app: express(),
          port: 0,
          resources: [],
          installSignalHandlers: false,
        });
        server = http.server;
        return http;
      },
      createWorker: () => {
        throw new Error('worker must not be created in web mode');
      },
    });

    assert.ok(runtime.http);
    assert.equal(runtime.worker, undefined);
    assert.equal(server?.listening, true);
    await runtime.shutdown('test');
    assert.equal(resource.closeCount, 1);
    assert.equal(server?.listening, false);
    server = undefined;
  });

  void it('starts the recurrence worker only in worker mode', async () => {
    const resource = recordingResource();
    const worker = recordingWorker();
    worker.releaseStop();
    const runtime = startProcess({
      mode: 'worker',
      resources: [resource],
      installSignalHandlers: false,
      createHttp: () => {
        throw new Error('HTTP must not be created in worker mode');
      },
      createWorker: () => worker,
    });

    assert.equal(runtime.http, undefined);
    assert.ok(runtime.worker);
    assert.equal(worker.started, true);
    await runtime.shutdown('test');
    assert.equal(worker.stopCount, 1);
    assert.equal(resource.closeCount, 1);
  });

  void it('starts HTTP and the worker in combined mode and closes the pool once', async () => {
    const resource = recordingResource();
    const worker = recordingWorker();
    const events: string[] = [];
    const runtime = startProcess({
      mode: 'combined',
      resources: [
        {
          close: () => {
            events.push('pool-close');
            return resource.close();
          },
        },
      ],
      installSignalHandlers: false,
      createHttp: () => {
        const http = startHttpServer({
          app: express(),
          port: 0,
          resources: [],
          installSignalHandlers: false,
        });
        server = http.server;
        return {
          stopAccepting: async () => {
            events.push('http-stop');
            await http.stopAccepting();
          },
        };
      },
      createWorker: () => ({
        start() {
          events.push('worker-start');
          worker.start();
        },
        async stop() {
          events.push('worker-stop');
          worker.releaseStop();
          await worker.stop();
        },
      }),
    });

    assert.ok(runtime.http);
    assert.ok(runtime.worker);
    assert.equal(server?.listening, true);
    await runtime.shutdown('test');
    assert.deepEqual(events, [
      'worker-start',
      'http-stop',
      'worker-stop',
      'pool-close',
    ]);
    assert.equal(resource.closeCount, 1);
    server = undefined;
  });

  void it('treats repeated shutdown as idempotent', async () => {
    const resource = recordingResource();
    const worker = recordingWorker();
    worker.releaseStop();
    const runtime = startProcess({
      mode: 'combined',
      resources: [resource],
      installSignalHandlers: false,
      createHttp: () => ({
        stopAccepting: () => Promise.resolve(),
      }),
      createWorker: () => worker,
    });

    await runtime.shutdown('first');
    await runtime.shutdown('second');
    await runtime.shutdown('third');
    assert.equal(worker.stopCount, 1);
    assert.equal(resource.closeCount, 1);
  });

  void it('waits for the worker to finish before closing the pool', async () => {
    const events: string[] = [];
    const worker = recordingWorker();
    const runtime = startProcess({
      mode: 'worker',
      resources: [
        {
          close: () => {
            events.push('pool-close');
            return Promise.resolve();
          },
        },
      ],
      installSignalHandlers: false,
      createWorker: () => ({
        start() {
          events.push('worker-start');
        },
        async stop() {
          events.push('worker-stop-begin');
          await worker.stopped;
          events.push('worker-stop-end');
        },
      }),
    });

    const shuttingDown = runtime.shutdown('test');
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(events.includes('pool-close'), false);
    worker.releaseStop();
    await shuttingDown;
    assert.deepEqual(events, [
      'worker-start',
      'worker-stop-begin',
      'worker-stop-end',
      'pool-close',
    ]);
  });

  void it('does not leave HTTP listening when combined startup cannot finish', async () => {
    const resource = recordingResource();
    const worker = recordingWorker();
    worker.releaseStop();
    let httpCreated = false;

    assert.throws(
      () =>
        startProcess({
          mode: 'combined',
          resources: [resource],
          installSignalHandlers: false,
          createWorker: () => worker,
          createHttp: () => {
            httpCreated = true;
            throw new Error('listen failed');
          },
        }),
      /listen failed/,
    );

    assert.equal(httpCreated, true);
    assert.equal(worker.started, false);
    assert.equal(resource.closeCount, 0);
    await resource.close();
    assert.equal(resource.closeCount, 1);
  });
});
