import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import express from 'express';
import type { Server } from 'node:http';
import { startHttpServer } from './start-http-server.js';

void describe('startHttpServer lifecycle', () => {
  /** @type {Server | undefined} */
  let server: Server | undefined;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
    }
    server = undefined;
  });

  void it('listens and shuts down, closing resources once', async () => {
    const app = express();
    app.get('/ping', (_req, res) => {
      res.status(200).json({ ok: true });
    });

    let closeCount = 0;
    const resource = {
      close: () => {
        closeCount += 1;
        return Promise.resolve();
      },
    };

    const runtime = startHttpServer({
      app,
      port: 0,
      resources: [resource],
      installSignalHandlers: false,
    });
    server = runtime.server;

    await new Promise<void>((resolve, reject) => {
      server!.once('listening', () => resolve());
      server!.once('error', reject);
    });

    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const port = address.port;

    const response = await fetch(`http://127.0.0.1:${port}/ping`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });

    await runtime.shutdown('test');
    assert.equal(closeCount, 1);
    assert.equal(server.listening, false);
    server = undefined;
  });

  void it('treats repeated shutdown as idempotent', async () => {
    const app = express();
    let closeCount = 0;
    const runtime = startHttpServer({
      app,
      port: 0,
      resources: [
        {
          close: () => {
            closeCount += 1;
            return Promise.resolve();
          },
        },
      ],
      installSignalHandlers: false,
    });
    server = runtime.server;

    await new Promise<void>((resolve, reject) => {
      server!.once('listening', () => resolve());
      server!.once('error', reject);
    });

    await runtime.shutdown('first');
    await runtime.shutdown('second');
    await runtime.shutdown('third');

    assert.equal(closeCount, 1);
    assert.equal(server.listening, false);
    server = undefined;
  });
});
