import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AppConfig } from '../config/types.js';
import type { PersistenceReadiness } from '../persistence/readiness.js';
import { appRequest } from './app-request.test-helper.js';
import {
  assertNoForbiddenLeak,
  COMMON_SECRET_SENTINELS,
} from './assert-no-forbidden-leak.js';
import { REQUEST_ID_HEADER } from './constants.js';
import { createApp } from './create-app.js';
import type { ApiErrorBody } from './errors.js';

const testConfig: Pick<AppConfig, 'trustedOrigins' | 'trustProxyHops'> = {
  trustedOrigins: ['http://localhost:5173', 'https://app.example'],
  trustProxyHops: 0,
};

function readyAlways(): PersistenceReadiness {
  return {
    checkReady: () => Promise.resolve(true),
  };
}

function readyNever(): PersistenceReadiness {
  return {
    checkReady: () => Promise.resolve(false),
  };
}

function buildApp(
  readiness: PersistenceReadiness = readyAlways(),
  configure?: Parameters<typeof createApp>[0]['configure'],
) {
  return createApp({
    config: testConfig,
    readiness,
    configure,
  });
}

void describe('HTTP platform app', () => {
  void it('GET /health returns 200 without depending on readiness', async () => {
    const app = buildApp(readyNever());
    const res = await appRequest(app, { path: '/health' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), { status: 'ok' });
  });

  void it('assigns a server request ID and returns it on the response', async () => {
    const app = buildApp();
    const res = await appRequest(app, { path: '/health' });
    const requestId = res.headers.get(REQUEST_ID_HEADER);
    assert.ok(requestId);
    assert.match(requestId, /^[0-9a-f-]{36}$/i);
  });

  void it('ignores client-supplied request IDs', async () => {
    const app = buildApp();
    const res = await appRequest(app, {
      path: '/health',
      headers: { [REQUEST_ID_HEADER]: 'client-controlled-id' },
    });
    assert.notEqual(res.headers.get(REQUEST_ID_HEADER), 'client-controlled-id');
  });

  void it('unknown route returns safe 404 with requestId', async () => {
    const app = buildApp();
    const res = await appRequest(app, { path: '/no-such-route' });
    assert.equal(res.status, 404);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.equal(body.error.message, 'Not found');
    assert.equal(body.error.requestId, res.headers.get(REQUEST_ID_HEADER));
    assert.equal(res.text.includes('stack'), false);
  });

  void it('thrown handler error returns safe 500 with same requestId', async () => {
    const app = buildApp(readyAlways(), (expressApp) => {
      expressApp.get('/boom', () => {
        throw new Error('secret db detail should not leak');
      });
    });

    const res = await appRequest(app, { path: '/boom' });
    assert.equal(res.status, 500);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.equal(body.error.message, 'An unexpected error occurred');
    assert.equal(body.error.requestId, res.headers.get(REQUEST_ID_HEADER));
    assertNoForbiddenLeak({
      context: '500 response body',
      text: res.text,
      forbidden: [
        ...COMMON_SECRET_SENTINELS,
        'secret db detail should not leak',
        'stack',
      ],
    });
  });

  void it('allowed CORS origin receives CORS headers', async () => {
    const app = buildApp();
    const res = await appRequest(app, {
      path: '/health',
      headers: { Origin: 'http://localhost:5173' },
    });
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get('access-control-allow-origin'),
      'http://localhost:5173',
    );
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
  });

  void it('disallowed origin does not receive permissive CORS access', async () => {
    const app = buildApp();
    const res = await appRequest(app, {
      path: '/health',
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  void it('request without Origin remains usable', async () => {
    const app = buildApp();
    const res = await appRequest(app, { path: '/health' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), { status: 'ok' });
  });

  void it('oversized JSON body is rejected safely', async () => {
    const app = buildApp();
    const oversized = JSON.stringify({ data: 'x'.repeat(40 * 1024) });
    const res = await appRequest(app, {
      method: 'POST',
      path: '/api/v1/anything',
      headers: { 'content-type': 'application/json' },
      body: oversized,
    });
    assert.equal(res.status, 413);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(body.error.requestId, res.headers.get(REQUEST_ID_HEADER));
    assert.equal(res.text.includes(oversized.slice(0, 32)), false);
  });

  void it('GET /ready returns 200 when DB probe succeeds', async () => {
    const app = buildApp(readyAlways());
    const res = await appRequest(app, { path: '/ready' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), { status: 'ready' });
  });

  void it('GET /ready returns 503 with safe payload when DB probe fails', async () => {
    const app = buildApp(readyNever());
    const res = await appRequest(app, { path: '/ready' });
    assert.equal(res.status, 503);
    assert.deepEqual(res.json(), { status: 'not_ready' });
    assert.equal(res.text.includes('DATABASE_URL'), false);
    assert.equal(res.text.includes('postgresql'), false);
  });

  void it('security headers are present on normal API responses', async () => {
    const app = buildApp();
    const res = await appRequest(app, { path: '/health' });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('x-content-type-options'));
    assert.ok(
      res.headers.get('x-frame-options') ||
        res.headers.get('content-security-policy'),
    );
    assert.equal(res.headers.get('x-powered-by'), null);
  });
});
