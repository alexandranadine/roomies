import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AuthRuntime } from '../auth/runtime.js';
import { withAppServer } from './app-request.test-helper.js';
import { REQUEST_ID_HEADER } from './constants.js';
import { createApp } from './create-app.js';
import type { ApiErrorBody } from './errors.js';
import { createInMemoryRateLimitRuntime } from './rate-limit.js';

const TRUSTED_ORIGIN = 'http://localhost:5173';
const CLIENT_A = '203.0.113.10';
const CLIENT_B = '198.51.100.20';
const SPOOFED = '192.0.2.99';

function stubAuth(handlerCalls: number[]) {
  return {
    handler: () => {
      handlerCalls.push(1);
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  } as unknown as AuthRuntime;
}

void describe('trust-proxy hop count and forwarded-header spoofing', () => {
  void it('ignores X-Forwarded-For when TRUST_PROXY hops is 0', async () => {
    const app = createApp({
      config: { trustedOrigins: [TRUSTED_ORIGIN], trustProxyHops: 0 },
      readiness: { checkReady: () => Promise.resolve(true) },
      configure(expressApp) {
        expressApp.get('/__test/ip', (req, res) => {
          res.status(200).json({ ip: req.ip, ips: req.ips });
        });
      },
    });

    await withAppServer(app, async (request) => {
      const direct = await request({ path: '/__test/ip' });
      const spoofed = await request({
        path: '/__test/ip',
        headers: { 'X-Forwarded-For': `${SPOOFED}, ${CLIENT_A}` },
      });
      const directBody = direct.json() as { ip: string; ips: string[] };
      const spoofedBody = spoofed.json() as { ip: string; ips: string[] };
      assert.equal(direct.status, 200);
      assert.equal(spoofedBody.ip, directBody.ip);
      assert.notEqual(spoofedBody.ip, SPOOFED);
      assert.notEqual(spoofedBody.ip, CLIENT_A);
      assert.deepEqual(spoofedBody.ips, []);
    });
  });

  void it('uses the hop-count address from the right of X-Forwarded-For', async () => {
    const app = createApp({
      config: { trustedOrigins: [TRUSTED_ORIGIN], trustProxyHops: 1 },
      readiness: { checkReady: () => Promise.resolve(true) },
      configure(expressApp) {
        expressApp.get('/__test/ip', (req, res) => {
          res.status(200).json({ ip: req.ip, ips: req.ips });
        });
      },
    });

    await withAppServer(app, async (request) => {
      const proxied = await request({
        path: '/__test/ip',
        headers: { 'X-Forwarded-For': CLIENT_A },
      });
      const multiHop = await request({
        path: '/__test/ip',
        headers: { 'X-Forwarded-For': `${SPOOFED}, ${CLIENT_A}` },
      });
      const rotated = await request({
        path: '/__test/ip',
        headers: { 'X-Forwarded-For': `${CLIENT_B}, ${CLIENT_A}` },
      });

      assert.equal((proxied.json() as { ip: string }).ip, CLIENT_A);
      assert.equal((multiHop.json() as { ip: string }).ip, CLIENT_A);
      assert.equal((rotated.json() as { ip: string }).ip, CLIENT_A);
      assert.notEqual((rotated.json() as { ip: string }).ip, CLIENT_B);
    });
  });

  void it('does not let a client-controlled X-Forwarded-For bypass credential limits at hops=0', async () => {
    const handlerCalls: number[] = [];
    const rateLimits = createInMemoryRateLimitRuntime({
      policies: { credential: { max: 2, windowMs: 60_000 } },
    });
    const app = createApp({
      config: { trustedOrigins: [TRUSTED_ORIGIN], trustProxyHops: 0 },
      readiness: { checkReady: () => Promise.resolve(true) },
      rateLimits,
      auth: stubAuth(handlerCalls),
    });

    try {
      await withAppServer(app, async (request) => {
        for (const spoof of [CLIENT_A, CLIENT_B]) {
          const res = await request({
            method: 'POST',
            path: '/api/auth/sign-in/email',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
              'X-Forwarded-For': spoof,
            },
            body: JSON.stringify({
              email: 'anyone@example.test',
              password: 'not-a-real-password',
            }),
          });
          assert.equal(res.status, 200);
        }

        const blocked = await request({
          method: 'POST',
          path: '/api/auth/sign-in/email',
          headers: {
            Origin: TRUSTED_ORIGIN,
            'content-type': 'application/json',
            'X-Forwarded-For': SPOOFED,
          },
          body: JSON.stringify({
            email: 'anyone@example.test',
            password: 'not-a-real-password',
          }),
        });
        assert.equal(blocked.status, 429);
        const body = blocked.json() as ApiErrorBody;
        assert.equal(body.error.code, 'RATE_LIMITED');
        assert.equal(
          body.error.requestId,
          blocked.headers.get(REQUEST_ID_HEADER),
        );
        assert.equal(handlerCalls.length, 2);
        assert.equal(blocked.text.includes(SPOOFED), false);
      });
    } finally {
      rateLimits.stop();
    }
  });

  void it('separates credential buckets by trusted hop identity when hops=1', async () => {
    const handlerCalls: number[] = [];
    const rateLimits = createInMemoryRateLimitRuntime({
      policies: { credential: { max: 1, windowMs: 60_000 } },
    });
    const app = createApp({
      config: { trustedOrigins: [TRUSTED_ORIGIN], trustProxyHops: 1 },
      readiness: { checkReady: () => Promise.resolve(true) },
      rateLimits,
      auth: stubAuth(handlerCalls),
    });

    try {
      await withAppServer(app, async (request) => {
        const first = await request({
          method: 'POST',
          path: '/api/auth/sign-in/email',
          headers: {
            Origin: TRUSTED_ORIGIN,
            'content-type': 'application/json',
            'X-Forwarded-For': `${SPOOFED}, ${CLIENT_A}`,
          },
          body: JSON.stringify({
            email: 'anyone@example.test',
            password: 'not-a-real-password',
          }),
        });
        assert.equal(first.status, 200);

        const sameClient = await request({
          method: 'POST',
          path: '/api/auth/sign-in/email',
          headers: {
            Origin: TRUSTED_ORIGIN,
            'content-type': 'application/json',
            'X-Forwarded-For': `${CLIENT_B}, ${CLIENT_A}`,
          },
          body: JSON.stringify({
            email: 'anyone@example.test',
            password: 'not-a-real-password',
          }),
        });
        assert.equal(sameClient.status, 429);

        const otherClient = await request({
          method: 'POST',
          path: '/api/auth/sign-in/email',
          headers: {
            Origin: TRUSTED_ORIGIN,
            'content-type': 'application/json',
            'X-Forwarded-For': CLIENT_B,
          },
          body: JSON.stringify({
            email: 'anyone@example.test',
            password: 'not-a-real-password',
          }),
        });
        assert.equal(otherClient.status, 200);
        assert.equal(handlerCalls.length, 2);
      });
    } finally {
      rateLimits.stop();
    }
  });
});
