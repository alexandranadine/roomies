import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AppConfig } from '../config/types.js';
import type { PersistenceReadiness } from '../persistence/readiness.js';
import { appRequest } from './app-request.test-helper.js';
import {
  assertNoForbiddenLeak,
  COMMON_SECRET_SENTINELS,
} from './assert-no-forbidden-leak.js';
import { readFile } from 'node:fs/promises';
import { AUTH_HTTP_ROUTE } from '../auth/http.js';
import type { AuthRuntime } from '../auth/runtime.js';
import { HTTP_PIPELINE_ORDER, REQUEST_ID_HEADER } from './constants.js';
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

  void it('lets a syntactically valid JSON null reach the route', async () => {
    const app = buildApp(readyAlways(), (expressApp) => {
      expressApp.post('/echo-body', (req, res) => {
        res
          .status(200)
          .json({ received: req.body === null ? 'null' : 'other' });
      });
    });
    const res = await appRequest(app, {
      method: 'POST',
      path: '/echo-body',
      headers: { 'content-type': 'application/json' },
      body: 'null',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), { received: 'null' });
  });

  void it('maps malformed JSON syntax to BAD_REQUEST', async () => {
    const app = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: '/api/v1/anything',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    });
    assert.equal(res.status, 400);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'BAD_REQUEST');
    assert.equal(body.error.message, 'Invalid JSON body');
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

  void it('keeps Better Auth mounted before Roomies JSON parsing', async () => {
    const source = await readFile(
      new URL('./create-app.ts', import.meta.url),
      'utf8',
    );
    const authMount = source.indexOf('AUTH_HTTP_ROUTE');
    const jsonParser = source.indexOf('express.json(');
    assert.ok(authMount >= 0);
    assert.ok(jsonParser >= 0);
    assert.ok(authMount < jsonParser);
    assert.equal(AUTH_HTTP_ROUTE, '/api/auth/*splat');
    assert.deepEqual(HTTP_PIPELINE_ORDER, [
      'trust-proxy',
      'request-id',
      'security-headers',
      'cors',
      'better-auth',
      'json-body',
      'health',
      'roomies-api',
      'not-found',
      'error-boundary',
    ]);
  });

  void it('unexpected auth handler errors do not leak SQL or secrets', async () => {
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map((value) => JSON.stringify(value)).join(' '));
    };

    try {
      const app = createApp({
        config: testConfig,
        readiness: readyAlways(),
        auth: {
          handler: () => {
            throw new Error(
              'SELECT password FROM auth_accounts WHERE token=super_secret',
            );
          },
        } as unknown as AuthRuntime,
      });

      const res = await appRequest(app, { path: '/api/auth/ok' });
      assert.equal(res.status, 500);
      const body = res.json() as ApiErrorBody;
      assert.equal(body.error.code, 'INTERNAL_ERROR');
      assert.equal(body.error.requestId, res.headers.get(REQUEST_ID_HEADER));
      assertNoForbiddenLeak({
        context: 'auth unexpected error response',
        text: res.text,
        forbidden: [
          ...COMMON_SECRET_SENTINELS,
          'SELECT password',
          'auth_accounts',
          'super_secret',
          'stack',
        ],
      });
      assertNoForbiddenLeak({
        context: 'auth unexpected error logs',
        text: logs.join('\n'),
        forbidden: [
          ...COMMON_SECRET_SENTINELS,
          'SELECT password',
          'super_secret',
          'Cookie',
          'Authorization',
        ],
      });
    } finally {
      console.error = originalError;
    }
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
