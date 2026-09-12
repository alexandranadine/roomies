import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Router } from 'express';
import { normalizeTrustedOrigin } from '../config/normalize-origin.js';
import { appRequest } from './app-request.test-helper.js';
import { REQUEST_ID_HEADER } from './constants.js';
import { createApp } from './create-app.js';
import type { ApiErrorBody } from './errors.js';
import { API_MUTATION_METHODS } from './mutation-origin.js';

const TRUSTED_A = 'http://localhost:5173';
const TRUSTED_B = 'https://app.example';
const HOSTILE = 'https://evil.example';

function buildGuardedApp(input?: { trustedOrigins?: readonly string[] }): {
  app: ReturnType<typeof createApp>;
  mutations: string[];
  reads: string[];
} {
  const mutations: string[] = [];
  const reads: string[] = [];
  const roomiesApi = Router();

  const recordMutation =
    (method: string) =>
    (_req: unknown, res: { status: (code: number) => { end: () => void } }) => {
      mutations.push(method);
      res.status(204).end();
    };

  roomiesApi.post('/probe', recordMutation('POST'));
  roomiesApi.put('/probe', recordMutation('PUT'));
  roomiesApi.patch('/probe', recordMutation('PATCH'));
  roomiesApi.delete('/probe', recordMutation('DELETE'));
  roomiesApi.get('/probe', (_req, res) => {
    reads.push('GET');
    res.status(200).json({ ok: true });
  });
  roomiesApi.head('/probe', (_req, res) => {
    reads.push('HEAD');
    res.status(200).end();
  });

  return {
    mutations,
    reads,
    app: createApp({
      config: {
        trustedOrigins: input?.trustedOrigins ?? [TRUSTED_A, TRUSTED_B],
        trustProxyHops: 0,
      },
      readiness: { checkReady: () => Promise.resolve(true) },
      roomiesApi,
    }),
  };
}

function assertForbiddenOrigin(res: {
  status: number;
  text: string;
  headers: Headers;
  json: () => unknown;
}): void {
  assert.equal(res.status, 403);
  const body = res.json() as ApiErrorBody;
  assert.equal(body.error.code, 'FORBIDDEN');
  assert.equal(body.error.message, 'Forbidden');
  assert.equal(body.error.requestId, res.headers.get(REQUEST_ID_HEADER));
  assert.equal(res.text.includes(HOSTILE), false);
  assert.equal(res.text.includes(TRUSTED_A), false);
  assert.equal(res.text.includes(TRUSTED_B), false);
  assert.equal(res.text.includes('TRUSTED_ORIGINS'), false);
  assert.equal(res.text.includes('trustedOrigins'), false);
  assert.equal(res.text.includes('stack'), false);
}

async function mutate(
  app: ReturnType<typeof createApp>,
  method: string,
  origin?: string,
  path = '/api/v1/probe',
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (origin !== undefined) {
    headers.Origin = origin;
  }
  return appRequest(app, {
    method,
    path,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : '{}',
  });
}

void describe('API mutation origin guard', () => {
  void it('protects the documented unsafe HTTP methods', () => {
    assert.deepEqual(
      [...API_MUTATION_METHODS],
      ['POST', 'PUT', 'PATCH', 'DELETE'],
    );
  });

  void it('allows POST from a trusted Origin and reaches the handler', async () => {
    const { app, mutations } = buildGuardedApp();
    const res = await mutate(app, 'POST', TRUSTED_A);
    assert.equal(res.status, 204);
    assert.deepEqual(mutations, ['POST']);
  });

  void it('allows PATCH from a trusted Origin and reaches the handler', async () => {
    const { app, mutations } = buildGuardedApp();
    const res = await mutate(app, 'PATCH', TRUSTED_B);
    assert.equal(res.status, 204);
    assert.deepEqual(mutations, ['PATCH']);
  });

  void it('allows DELETE from a trusted Origin and reaches the handler', async () => {
    const { app, mutations } = buildGuardedApp();
    const res = await mutate(app, 'DELETE', TRUSTED_A);
    assert.equal(res.status, 204);
    assert.deepEqual(mutations, ['DELETE']);
  });

  void it('rejects a hostile Origin before the mutation handler', async () => {
    const { app, mutations } = buildGuardedApp();
    const res = await mutate(app, 'POST', HOSTILE);
    assertForbiddenOrigin(res);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.deepEqual(mutations, []);
  });

  void it('rejects lookalike and subdomain hostile Origins', async () => {
    const { app, mutations } = buildGuardedApp({
      trustedOrigins: [TRUSTED_B],
    });
    for (const origin of [
      'https://evil.app.example',
      'https://app.example.evil.com',
      'https://app-example.com',
    ]) {
      const res = await mutate(app, 'POST', origin);
      assertForbiddenOrigin(res);
    }
    assert.deepEqual(mutations, []);
  });

  void it('rejects a malformed Origin before the mutation handler', async () => {
    const { app, mutations } = buildGuardedApp();
    for (const origin of [
      'not-a-url',
      'null',
      'ftp://app.example',
      'https://app.example/path',
    ]) {
      const res = await mutate(app, 'PATCH', origin);
      assertForbiddenOrigin(res);
    }
    assert.deepEqual(mutations, []);
  });

  void it('rejects a missing Origin on unsafe /api/v1 mutations', async () => {
    const { app, mutations } = buildGuardedApp();
    const res = await mutate(app, 'POST');
    assertForbiddenOrigin(res);
    assert.deepEqual(mutations, []);
  });

  void it('does not reject GET when Origin is absent or hostile', async () => {
    const { app, mutations, reads } = buildGuardedApp();
    const missing = await mutate(app, 'GET');
    assert.equal(missing.status, 200);
    assert.deepEqual(missing.json(), { ok: true });

    const hostile = await mutate(app, 'GET', HOSTILE);
    assert.equal(hostile.status, 200);
    assert.equal(hostile.headers.get('access-control-allow-origin'), null);

    assert.deepEqual(mutations, []);
    assert.deepEqual(reads, ['GET', 'GET']);
  });

  void it('does not reject HEAD when Origin is absent or hostile', async () => {
    const { app, mutations } = buildGuardedApp();
    const missing = await mutate(app, 'HEAD');
    assert.equal(missing.status, 200);

    const hostile = await mutate(app, 'HEAD', HOSTILE);
    assert.equal(hostile.status, 200);

    assert.deepEqual(mutations, []);
  });

  void it('leaves OPTIONS preflight to CORS and does not run the handler', async () => {
    const { app, mutations } = buildGuardedApp();

    const trusted = await appRequest(app, {
      method: 'OPTIONS',
      path: '/api/v1/probe',
      headers: {
        Origin: TRUSTED_A,
        'Access-Control-Request-Method': 'POST',
      },
    });
    assert.ok(trusted.status >= 200 && trusted.status < 300);
    assert.equal(trusted.headers.get('access-control-allow-origin'), TRUSTED_A);

    const hostile = await appRequest(app, {
      method: 'OPTIONS',
      path: '/api/v1/probe',
      headers: {
        Origin: HOSTILE,
        'Access-Control-Request-Method': 'POST',
      },
    });
    assert.ok(hostile.status >= 200 && hostile.status < 500);
    assert.equal(hostile.headers.get('access-control-allow-origin'), null);
    assert.deepEqual(mutations, []);
  });

  void it('supports multiple trusted origins without prefix or suffix matching', async () => {
    const { app, mutations } = buildGuardedApp({
      trustedOrigins: [TRUSTED_A, TRUSTED_B],
    });

    const first = await mutate(app, 'POST', TRUSTED_A);
    assert.equal(first.status, 204);
    const second = await mutate(app, 'PUT', TRUSTED_B);
    assert.equal(second.status, 204);

    const prefix = await mutate(
      app,
      'POST',
      'https://app.example.attacker.com',
    );
    assertForbiddenOrigin(prefix);
    const suffix = await mutate(app, 'POST', 'https://notapp.example');
    assertForbiddenOrigin(suffix);
    const scheme = await mutate(app, 'POST', 'http://app.example');
    assertForbiddenOrigin(scheme);

    assert.deepEqual(mutations, ['POST', 'PUT']);
  });

  void it('matches default-port Origins using the frozen origin normalizer', async () => {
    const httpsOrigin = normalizeTrustedOrigin('https://app.example:443');
    const httpOrigin = normalizeTrustedOrigin('http://localhost:80');
    assert.equal(httpsOrigin, 'https://app.example');
    assert.equal(httpOrigin, 'http://localhost');

    const { app, mutations } = buildGuardedApp({
      trustedOrigins: [httpsOrigin, httpOrigin],
    });

    const httpsDefaultPort = await mutate(
      app,
      'POST',
      'https://app.example:443',
    );
    assert.equal(httpsDefaultPort.status, 204);
    const httpDefaultPort = await mutate(app, 'PATCH', 'http://localhost:80');
    assert.equal(httpDefaultPort.status, 204);
    const nonDefaultPort = await mutate(
      app,
      'POST',
      'https://app.example:8443',
    );
    assertForbiddenOrigin(nonDefaultPort);

    assert.deepEqual(mutations, ['POST', 'PATCH']);
  });

  void it('does not treat FRONTEND_ORIGIN as authorization input', async () => {
    const frontendOrigin = 'http://localhost:5173';
    const { app, mutations } = buildGuardedApp({
      trustedOrigins: ['http://127.0.0.1:5173'],
    });
    const res = await mutate(app, 'POST', frontendOrigin);
    assertForbiddenOrigin(res);
    assert.deepEqual(mutations, []);
  });
});
