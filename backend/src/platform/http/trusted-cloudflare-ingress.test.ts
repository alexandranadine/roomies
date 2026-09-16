import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AuthRuntime } from '../auth/runtime.js';
import { createRoomiesApiRouter } from '../../http/create-roomies-api.js';
import { appRequest, withAppServer } from './app-request.test-helper.js';
import {
  assertNoForbiddenLeak,
  COMMON_SECRET_SENTINELS,
} from './assert-no-forbidden-leak.js';
import { REQUEST_ID_HEADER } from './constants.js';
import { createApp } from './create-app.js';
import type { ApiErrorBody } from './errors.js';
import {
  IP_PROBE_PATH,
  IP_PROBE_TOKEN_HEADER,
  createIpProbeHandler,
  hashNetworkValue,
  type IpProbeDiagnostic,
} from './ip-probe.js';
import { createInMemoryRateLimitRuntime } from './rate-limit.js';
import {
  CF_CONNECTING_IP_HEADER,
  CLOUDFLARE_ORIGIN_AUTH_HEADER,
  parseSingleClientIp,
} from './trusted-cloudflare-ingress.js';

const TRUSTED_ORIGIN = 'http://localhost:5173';
const ORIGIN_SECRET = 'roomies_cf_origin_auth_secret_32_chars_min';
const WRONG_SECRET = 'roomies_cf_origin_auth_secret_32_chars_bad';
const PROBE_TOKEN = 'roomies_test_secret_32_chars_minimum_value';
const CLIENT_A = '203.0.113.10';
const CLIENT_B = '198.51.100.20';
const SPOOFED = '192.0.2.99';
const IPV6_CANONICAL = '2001:db8::1';
const IPV6_EXPANDED = '2001:0db8:0000:0000:0000:0000:0000:0001';
const INVITATION_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const INVITE_SECRET = 'invitation-secret-must-not-be-a-limiter-key';
const NOW = new Date('2026-09-15T18:00:00.000Z');

const LEAK_SENTINELS = [
  ...COMMON_SECRET_SENTINELS,
  ORIGIN_SECRET,
  WRONG_SECRET,
  CLIENT_A,
  CLIENT_B,
  SPOOFED,
  IPV6_CANONICAL,
  IPV6_EXPANDED,
  'X-Roomies-Origin-Auth',
  'CF-Connecting-IP',
  'Authorization',
  'cookie-secret',
] as const;

function cloudflareConfig(trustProxyHops = 2) {
  return {
    trustedOrigins: [TRUSTED_ORIGIN],
    trustProxyHops,
    ingress: {
      mode: 'cloudflare' as const,
      originAuthSecret: ORIGIN_SECRET,
    },
  };
}

function originHeaders(
  connectingIp: string,
  extra: Record<string, string | readonly string[]> = {},
): Record<string, string | readonly string[]> {
  return {
    [CLOUDFLARE_ORIGIN_AUTH_HEADER]: ORIGIN_SECRET,
    [CF_CONNECTING_IP_HEADER]: connectingIp,
    Origin: TRUSTED_ORIGIN,
    ...extra,
  };
}

function stubAuth(handlerCalls: string[]) {
  return {
    handler: () => {
      handlerCalls.push('auth');
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
    api: {
      getSession: () => Promise.resolve(null),
    },
    options: {},
  } as unknown as AuthRuntime;
}

function unusedHomeDependencies() {
  return {
    activeHomeActorResolver: {
      resolve: () => Promise.reject(new Error('home actor must not run')),
    },
    homeReader: {
      findActiveHomeById: () =>
        Promise.reject(new Error('home reader must not run')),
    },
    archiveFinalMemberHome: () =>
      Promise.reject(new Error('archive must not run')),
    changeMembershipRole: () =>
      Promise.reject(new Error('role change must not run')),
    leaveMembership: () => Promise.reject(new Error('leave must not run')),
    removeMembership: () => Promise.reject(new Error('remove must not run')),
  };
}

function assertForbidden(res: {
  status: number;
  text: string;
  headers: Headers;
  json: () => unknown;
}): ApiErrorBody {
  assert.equal(res.status, 403);
  const body = res.json() as ApiErrorBody;
  assert.equal(body.error.code, 'FORBIDDEN');
  assert.equal(body.error.message, 'Forbidden');
  assert.equal(body.error.requestId, res.headers.get(REQUEST_ID_HEADER));
  assertNoForbiddenLeak({
    context: 'cloudflare ingress 403',
    text: res.text,
    forbidden: LEAK_SENTINELS,
  });
  return body;
}

function assertRateLimited(res: {
  status: number;
  text: string;
  headers: Headers;
  json: () => unknown;
}): ApiErrorBody {
  assert.equal(res.status, 429);
  const body = res.json() as ApiErrorBody;
  assert.equal(body.error.code, 'RATE_LIMITED');
  assert.equal(body.error.message, 'Too many requests');
  assert.equal(body.error.requestId, res.headers.get(REQUEST_ID_HEADER));
  return body;
}

void describe('parseSingleClientIp', () => {
  void it('accepts a valid IPv4 address', () => {
    assert.equal(parseSingleClientIp(CLIENT_A), CLIENT_A);
  });

  void it('accepts IPv6 and normalizes equivalent forms to one identity', () => {
    assert.equal(parseSingleClientIp(IPV6_CANONICAL), IPV6_CANONICAL);
    assert.equal(parseSingleClientIp(IPV6_EXPANDED), IPV6_CANONICAL);
    assert.equal(parseSingleClientIp('2001:DB8::1'), IPV6_CANONICAL);
    assert.equal(parseSingleClientIp('::1'), '::1');
    assert.equal(parseSingleClientIp('::ffff:192.0.2.9'), '192.0.2.9');
  });

  void it('rejects comma-separated, duplicate-looking, and malformed values', () => {
    assert.equal(parseSingleClientIp(`${CLIENT_A}, ${CLIENT_B}`), undefined);
    assert.equal(parseSingleClientIp(`${CLIENT_A},${CLIENT_B}`), undefined);
    assert.equal(parseSingleClientIp('not-an-ip'), undefined);
    assert.equal(parseSingleClientIp('203.0.113.10:443'), undefined);
    assert.equal(parseSingleClientIp('[2001:db8::1]'), undefined);
    assert.equal(parseSingleClientIp('2001:db8::1/64'), undefined);
    assert.equal(parseSingleClientIp('fe80::1%eth0'), undefined);
    assert.equal(parseSingleClientIp(''), undefined);
    assert.equal(parseSingleClientIp('  '), undefined);
  });
});

void describe('trusted Cloudflare ingress', () => {
  void it('stores a trusted limiter identity after valid origin auth and one CF IP', async () => {
    const handlerCalls: string[] = [];
    const app = createApp({
      config: cloudflareConfig(2),
      readiness: { checkReady: () => Promise.resolve(true) },
      auth: stubAuth(handlerCalls),
    });

    const res = await appRequest(app, {
      method: 'POST',
      path: '/api/auth/sign-in/email',
      headers: {
        ...originHeaders(CLIENT_A),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        email: 'anyone@example.test',
        password: 'not-a-real-password',
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(handlerCalls.length, 1);
    assertNoForbiddenLeak({
      context: 'credential success',
      text: res.text,
      forbidden: LEAK_SENTINELS,
    });
  });

  void it('fails closed when the origin-auth header is missing', async () => {
    const handlerCalls: string[] = [];
    const app = createApp({
      config: cloudflareConfig(),
      readiness: { checkReady: () => Promise.resolve(true) },
      auth: stubAuth(handlerCalls),
    });
    const res = await appRequest(app, {
      method: 'POST',
      path: '/api/auth/sign-in/email',
      headers: {
        [CF_CONNECTING_IP_HEADER]: CLIENT_A,
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assertForbidden(res);
    assert.equal(handlerCalls.length, 0);
  });

  void it('fails closed when the origin-auth header is wrong', async () => {
    const handlerCalls: string[] = [];
    const app = createApp({
      config: cloudflareConfig(),
      readiness: { checkReady: () => Promise.resolve(true) },
      auth: stubAuth(handlerCalls),
    });
    const res = await appRequest(app, {
      method: 'POST',
      path: '/api/auth/sign-in/email',
      headers: originHeaders(CLIENT_A, {
        [CLOUDFLARE_ORIGIN_AUTH_HEADER]: WRONG_SECRET,
      }),
      body: '{}',
    });
    assertForbidden(res);
    assert.equal(handlerCalls.length, 0);
  });

  void it('fails closed when the origin-auth header is duplicated', async () => {
    const handlerCalls: string[] = [];
    const app = createApp({
      config: cloudflareConfig(),
      readiness: { checkReady: () => Promise.resolve(true) },
      auth: stubAuth(handlerCalls),
    });
    const res = await appRequest(app, {
      method: 'POST',
      path: '/api/auth/sign-in/email',
      headers: originHeaders(CLIENT_A, {
        [CLOUDFLARE_ORIGIN_AUTH_HEADER]: [ORIGIN_SECRET, ORIGIN_SECRET],
      }),
      body: '{}',
    });
    assertForbidden(res);
    assert.equal(handlerCalls.length, 0);
  });

  void it('fails closed when CF-Connecting-IP is missing', async () => {
    const handlerCalls: string[] = [];
    const app = createApp({
      config: cloudflareConfig(),
      readiness: { checkReady: () => Promise.resolve(true) },
      auth: stubAuth(handlerCalls),
    });
    const res = await appRequest(app, {
      method: 'POST',
      path: '/api/auth/sign-in/email',
      headers: {
        [CLOUDFLARE_ORIGIN_AUTH_HEADER]: ORIGIN_SECRET,
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assertForbidden(res);
    assert.equal(handlerCalls.length, 0);
  });

  void it('fails closed when CF-Connecting-IP is duplicated', async () => {
    const handlerCalls: string[] = [];
    const app = createApp({
      config: cloudflareConfig(),
      readiness: { checkReady: () => Promise.resolve(true) },
      auth: stubAuth(handlerCalls),
    });
    const res = await appRequest(app, {
      method: 'POST',
      path: '/api/auth/sign-in/email',
      headers: originHeaders(CLIENT_A, {
        [CF_CONNECTING_IP_HEADER]: [CLIENT_A, CLIENT_B],
      }),
      body: '{}',
    });
    assertForbidden(res);
    assert.equal(handlerCalls.length, 0);
  });

  void it('fails closed when CF-Connecting-IP is comma-separated', async () => {
    const handlerCalls: string[] = [];
    const app = createApp({
      config: cloudflareConfig(),
      readiness: { checkReady: () => Promise.resolve(true) },
      auth: stubAuth(handlerCalls),
    });
    const res = await appRequest(app, {
      method: 'POST',
      path: '/api/auth/sign-in/email',
      headers: originHeaders(`${CLIENT_A}, ${CLIENT_B}`),
      body: '{}',
    });
    assertForbidden(res);
    assert.equal(handlerCalls.length, 0);
  });

  void it('fails closed when CF-Connecting-IP is malformed', async () => {
    const handlerCalls: string[] = [];
    const app = createApp({
      config: cloudflareConfig(),
      readiness: { checkReady: () => Promise.resolve(true) },
      auth: stubAuth(handlerCalls),
    });
    for (const malformed of [
      'not-an-ip',
      '203.0.113.10:443',
      '[2001:db8::1]',
      '2001:db8::1/64',
    ]) {
      const res = await appRequest(app, {
        method: 'POST',
        path: '/api/auth/sign-in/email',
        headers: originHeaders(malformed),
        body: '{}',
      });
      assertForbidden(res);
    }
    assert.equal(handlerCalls.length, 0);
  });

  void it('accepts a valid IPv4 CF-Connecting-IP', async () => {
    const handlerCalls: string[] = [];
    const app = createApp({
      config: cloudflareConfig(),
      readiness: { checkReady: () => Promise.resolve(true) },
      auth: stubAuth(handlerCalls),
    });
    const res = await appRequest(app, {
      method: 'POST',
      path: '/api/auth/sign-in/email',
      headers: originHeaders(CLIENT_A),
      body: '{}',
    });
    assert.equal(res.status, 200);
    assert.equal(handlerCalls.length, 1);
  });

  void it('accepts equivalent IPv6 CF-Connecting-IP forms as one identity', async () => {
    const handlerCalls: string[] = [];
    const rateLimits = createInMemoryRateLimitRuntime({
      policies: { credential: { max: 1, windowMs: 60_000 } },
    });
    const app = createApp({
      config: cloudflareConfig(),
      readiness: { checkReady: () => Promise.resolve(true) },
      rateLimits,
      auth: stubAuth(handlerCalls),
    });
    try {
      const first = await appRequest(app, {
        method: 'POST',
        path: '/api/auth/sign-in/email',
        headers: originHeaders(IPV6_EXPANDED),
        body: '{}',
      });
      const second = await appRequest(app, {
        method: 'POST',
        path: '/api/auth/sign-in/email',
        headers: originHeaders(IPV6_CANONICAL),
        body: '{}',
      });
      assert.equal(first.status, 200);
      assertRateLimited(second);
      assert.equal(handlerCalls.length, 1);
    } finally {
      rateLimits.stop();
    }
  });

  void it('ignores rotating XFF and X-Real-IP once origin auth succeeds', async () => {
    const handlerCalls: string[] = [];
    const rateLimits = createInMemoryRateLimitRuntime({
      policies: { credential: { max: 1, windowMs: 60_000 } },
    });
    const app = createApp({
      config: cloudflareConfig(2),
      readiness: { checkReady: () => Promise.resolve(true) },
      rateLimits,
      auth: stubAuth(handlerCalls),
    });
    try {
      await withAppServer(app, async (request) => {
        const first = await request({
          method: 'POST',
          path: '/api/auth/sign-in/email',
          headers: originHeaders(CLIENT_A, {
            'X-Forwarded-For': `${SPOOFED}, ${CLIENT_B}`,
            'X-Real-IP': CLIENT_B,
          }),
          body: '{}',
        });
        assert.equal(first.status, 200);

        const rotated = await request({
          method: 'POST',
          path: '/api/auth/sign-in/email',
          headers: originHeaders(CLIENT_A, {
            'X-Forwarded-For': `${CLIENT_B}, ${SPOOFED}`,
            'X-Real-IP': SPOOFED,
          }),
          body: '{}',
        });
        assertRateLimited(rotated);
        assert.equal(handlerCalls.length, 1);
      });
    } finally {
      rateLimits.stop();
    }
  });

  void it('rejects a spoofed CF-Connecting-IP without valid edge auth', async () => {
    const handlerCalls: string[] = [];
    const app = createApp({
      config: cloudflareConfig(),
      readiness: { checkReady: () => Promise.resolve(true) },
      auth: stubAuth(handlerCalls),
    });
    const res = await appRequest(app, {
      method: 'POST',
      path: '/api/auth/sign-in/email',
      headers: {
        [CF_CONNECTING_IP_HEADER]: CLIENT_A,
        'X-Forwarded-For': CLIENT_A,
        'X-Real-IP': CLIENT_A,
        Host: 'api.roomies.example',
        Origin: TRUSTED_ORIGIN,
      },
      body: '{}',
    });
    assertForbidden(res);
    assert.equal(handlerCalls.length, 0);
  });

  void it('shares the credential bucket for one authenticated CF IP despite forwarding-header changes', async () => {
    const handlerCalls: string[] = [];
    const rateLimits = createInMemoryRateLimitRuntime({
      policies: { credential: { max: 2, windowMs: 60_000 } },
    });
    const app = createApp({
      config: cloudflareConfig(0),
      readiness: { checkReady: () => Promise.resolve(true) },
      rateLimits,
      auth: stubAuth(handlerCalls),
    });
    try {
      await withAppServer(app, async (request) => {
        for (const spoof of [CLIENT_B, SPOOFED]) {
          const res = await request({
            method: 'POST',
            path: '/api/auth/sign-in/email',
            headers: originHeaders(CLIENT_A, {
              'X-Forwarded-For': spoof,
              'X-Real-IP': spoof,
            }),
            body: '{}',
          });
          assert.equal(res.status, 200);
        }
        const blocked = await request({
          method: 'POST',
          path: '/api/auth/sign-in/email',
          headers: originHeaders(CLIENT_A, {
            'X-Forwarded-For': '8.8.8.8',
          }),
          body: '{}',
        });
        assertRateLimited(blocked);
        assert.equal(handlerCalls.length, 2);
      });
    } finally {
      rateLimits.stop();
    }
  });

  void it('uses different credential buckets for different authenticated CF IPs', async () => {
    const handlerCalls: string[] = [];
    const rateLimits = createInMemoryRateLimitRuntime({
      policies: { credential: { max: 1, windowMs: 60_000 } },
    });
    const app = createApp({
      config: cloudflareConfig(),
      readiness: { checkReady: () => Promise.resolve(true) },
      rateLimits,
      auth: stubAuth(handlerCalls),
    });
    try {
      const first = await appRequest(app, {
        method: 'POST',
        path: '/api/auth/sign-in/email',
        headers: originHeaders(CLIENT_A),
        body: '{}',
      });
      const other = await appRequest(app, {
        method: 'POST',
        path: '/api/auth/sign-in/email',
        headers: originHeaders(CLIENT_B),
        body: '{}',
      });
      const same = await appRequest(app, {
        method: 'POST',
        path: '/api/auth/sign-in/email',
        headers: originHeaders(CLIENT_A),
        body: '{}',
      });
      assert.equal(first.status, 200);
      assert.equal(other.status, 200);
      assertRateLimited(same);
      assert.equal(handlerCalls.length, 2);
    } finally {
      rateLimits.stop();
    }
  });

  void it('uses the same trusted identity for invitation preview and accept', async () => {
    const previewCalls: string[] = [];
    const rateLimits = createInMemoryRateLimitRuntime({
      policies: { invitation_token: { max: 1, windowMs: 60_000 } },
    });
    const app = createApp({
      config: cloudflareConfig(),
      readiness: { checkReady: () => Promise.resolve(true) },
      rateLimits,
      roomiesApi: createRoomiesApiRouter({
        principalResolver: {
          requirePrincipal: () =>
            Promise.resolve({
              userId: '11111111-1111-4111-8111-111111111111',
              sessionCreatedAt: NOW,
            }),
        },
        ...unusedHomeDependencies(),
        rateLimits,
        previewInvitation: (input) => {
          previewCalls.push(input.invitationId);
          return Promise.resolve({
            invitation: {
              id: input.invitationId,
              email: 'roommate@example.test',
              expiresAt: NOW,
              home: {
                id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                name: 'Home',
              },
            },
          });
        },
        acceptInvitation: () =>
          Promise.resolve({
            membershipId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            homeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          }),
      }),
    });

    try {
      const preview = await appRequest(app, {
        method: 'POST',
        path: `/api/v1/invitations/${INVITATION_ID}/preview`,
        headers: originHeaders(CLIENT_A, {
          Authorization: `Invitation ${INVITE_SECRET}`,
          'content-type': 'application/json',
        }),
        body: '{}',
      });
      const acceptSameIp = await appRequest(app, {
        method: 'POST',
        path: `/api/v1/invitations/${INVITATION_ID}/accept`,
        headers: originHeaders(CLIENT_A, {
          Authorization: `Invitation ${INVITE_SECRET}`,
          'X-Forwarded-For': CLIENT_B,
          'content-type': 'application/json',
        }),
        body: '{}',
      });
      const otherIp = await appRequest(app, {
        method: 'POST',
        path: `/api/v1/invitations/${INVITATION_ID}/preview`,
        headers: originHeaders(CLIENT_B, {
          Authorization: `Invitation ${INVITE_SECRET}`,
          'content-type': 'application/json',
        }),
        body: '{}',
      });
      assert.equal(preview.status, 200);
      assertRateLimited(acceptSameIp);
      assert.equal(otherIp.status, 200);
      assert.equal(previewCalls.length, 2);
      assert.equal(acceptSameIp.text.includes(INVITE_SECRET), false);
    } finally {
      rateLimits.stop();
    }
  });

  void it('does not change the trusted limiter identity when TRUST_PROXY hops change', async () => {
    const handlerCalls: string[] = [];
    const rateLimits = createInMemoryRateLimitRuntime({
      policies: { credential: { max: 1, windowMs: 60_000 } },
    });
    const makeApp = (trustProxyHops: number) =>
      createApp({
        config: cloudflareConfig(trustProxyHops),
        readiness: { checkReady: () => Promise.resolve(true) },
        rateLimits,
        auth: stubAuth(handlerCalls),
      });

    try {
      const first = await appRequest(makeApp(0), {
        method: 'POST',
        path: '/api/auth/sign-in/email',
        headers: originHeaders(CLIENT_A, {
          'X-Forwarded-For': `${SPOOFED}, ${CLIENT_B}`,
        }),
        body: '{}',
      });
      const second = await appRequest(makeApp(2), {
        method: 'POST',
        path: '/api/auth/sign-in/email',
        headers: originHeaders(CLIENT_A, {
          'X-Forwarded-For': `${CLIENT_B}, ${SPOOFED}`,
        }),
        body: '{}',
      });
      assert.equal(first.status, 200);
      assertRateLimited(second);
      assert.equal(handlerCalls.length, 1);
    } finally {
      rateLimits.stop();
    }
  });

  void it('never writes origin secrets or raw IPs to logs or error responses', async () => {
    const logs: string[] = [];
    const original = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };
    const capture =
      (name: keyof typeof original) =>
      (...args: unknown[]) => {
        logs.push(
          `${name}:${args.map((value) => JSON.stringify(value)).join(' ')}`,
        );
      };
    console.log = capture('log');
    console.info = capture('info');
    console.warn = capture('warn');
    console.error = capture('error');

    try {
      const app = createApp({
        config: cloudflareConfig(),
        readiness: { checkReady: () => Promise.resolve(true) },
        auth: stubAuth([]),
      });
      const forbidden = await appRequest(app, {
        method: 'POST',
        path: '/api/auth/sign-in/email',
        headers: originHeaders(CLIENT_A, {
          [CLOUDFLARE_ORIGIN_AUTH_HEADER]: WRONG_SECRET,
          Cookie: 'cookie-secret=1',
          Authorization: 'Bearer cookie-secret',
        }),
        body: '{}',
      });
      assertForbidden(forbidden);
      const allowed = await appRequest(app, {
        method: 'POST',
        path: '/api/auth/sign-in/email',
        headers: originHeaders(CLIENT_A),
        body: '{}',
      });
      assert.equal(allowed.status, 200);
      assertNoForbiddenLeak({
        context: 'ingress logs',
        text: logs.join('\n'),
        forbidden: LEAK_SENTINELS,
      });
    } finally {
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
    }
  });

  void it('blocks direct Railway-style requests from credential, invitation, and product handlers', async () => {
    const handlerCalls: string[] = [];
    const previewCalls: string[] = [];
    const productCalls: string[] = [];
    const app = createApp({
      config: cloudflareConfig(),
      readiness: { checkReady: () => Promise.resolve(true) },
      auth: stubAuth(handlerCalls),
      roomiesApi: createRoomiesApiRouter({
        principalResolver: {
          requirePrincipal: () =>
            Promise.reject(new Error('product must not run')),
        },
        ...unusedHomeDependencies(),
        previewInvitation: (input) => {
          previewCalls.push(input.invitationId);
          return Promise.resolve({
            invitation: {
              id: input.invitationId,
              email: 'roommate@example.test',
              expiresAt: NOW,
              home: {
                id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                name: 'Home',
              },
            },
          });
        },
      }),
      configure(expressApp) {
        expressApp.get('/__test/product', (_req, res) => {
          productCalls.push('product');
          res.status(200).json({ ok: true });
        });
      },
    });

    const credential = await appRequest(app, {
      method: 'POST',
      path: '/api/auth/sign-in/email',
      headers: {
        Origin: TRUSTED_ORIGIN,
        'X-Forwarded-For': CLIENT_A,
        'CF-Connecting-IP': CLIENT_A,
      },
      body: '{}',
    });
    const invitation = await appRequest(app, {
      method: 'POST',
      path: `/api/v1/invitations/${INVITATION_ID}/preview`,
      headers: {
        Origin: TRUSTED_ORIGIN,
        Authorization: `Invitation ${INVITE_SECRET}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    const me = await appRequest(app, { path: '/api/v1/me' });
    const product = await appRequest(app, { path: '/__test/product' });

    assertForbidden(credential);
    assertForbidden(invitation);
    assertForbidden(me);
    assertForbidden(product);
    assert.equal(handlerCalls.length, 0);
    assert.equal(previewCalls.length, 0);
    assert.equal(productCalls.length, 0);
  });

  void it('keeps health and ready available without establishing identity or opening other routes', async () => {
    const handlerCalls: string[] = [];
    const productCalls: string[] = [];
    const app = createApp({
      config: cloudflareConfig(),
      readiness: { checkReady: () => Promise.resolve(true) },
      auth: stubAuth(handlerCalls),
      configure(expressApp) {
        expressApp.get('/__test/product', (_req, res) => {
          productCalls.push('product');
          res.status(200).json({ ok: true });
        });
      },
    });

    const health = await appRequest(app, { path: '/health' });
    const ready = await appRequest(app, { path: '/ready' });
    const healthPost = await appRequest(app, {
      method: 'POST',
      path: '/health',
    });
    const credential = await appRequest(app, {
      method: 'POST',
      path: '/api/auth/ok',
    });
    const product = await appRequest(app, { path: '/__test/product' });

    assert.equal(health.status, 200);
    assert.deepEqual(health.json(), { status: 'ok' });
    assert.equal(ready.status, 200);
    assert.deepEqual(ready.json(), { status: 'ready' });
    assertForbidden(healthPost);
    assertForbidden(credential);
    assertForbidden(product);
    assert.equal(handlerCalls.length, 0);
    assert.equal(productCalls.length, 0);
  });

  void it('reports hashed trusted identity on the temporary probe without leaking secrets', async () => {
    const app = createApp({
      config: cloudflareConfig(2),
      readiness: { checkReady: () => Promise.resolve(true) },
      configure(expressApp) {
        expressApp.get(
          IP_PROBE_PATH,
          createIpProbeHandler({ token: PROBE_TOKEN, trustProxyHops: 2 }),
        );
      },
    });

    const res = await appRequest(app, {
      path: IP_PROBE_PATH,
      headers: originHeaders(CLIENT_A, {
        [IP_PROBE_TOKEN_HEADER]: PROBE_TOKEN,
        'X-Forwarded-For': `${SPOOFED}, ${CLIENT_B}`,
        'X-Real-IP': CLIENT_B,
        Cookie: 'cookie-secret=1',
      }),
    });
    assert.equal(res.status, 200);
    const body = res.json() as IpProbeDiagnostic;
    assert.equal(body.edgeAuthSucceeded, true);
    assert.equal(body.trustedLimiterIdentityHash, hashNetworkValue(CLIENT_A));
    assert.equal(body.trustedIdentityMatchesCfConnectingIp, true);
    assert.equal(body.trustedIdentityMatchesXffIntermediary, false);
    assert.equal(body.canaryInCfConnectingIp, true);
    assert.notEqual(body.trustedLimiterIdentityHash, body.reqIpHash);
    assertNoForbiddenLeak({
      context: 'cloudflare probe',
      text: res.text,
      forbidden: LEAK_SENTINELS,
    });
  });
});
