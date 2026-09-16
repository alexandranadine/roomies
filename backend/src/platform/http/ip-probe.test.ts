import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../config/errors.js';
import { appRequest, withAppServer } from './app-request.test-helper.js';
import {
  assertNoForbiddenLeak,
  COMMON_SECRET_SENTINELS,
} from './assert-no-forbidden-leak.js';
import { REQUEST_ID_HEADER } from './constants.js';
import { createApp } from './create-app.js';
import type { ApiErrorBody } from './errors.js';
import {
  IP_PROBE_HASH_LENGTH,
  IP_PROBE_PATH,
  IP_PROBE_TOKEN_HEADER,
  TEMPORARY_PRODUCTION_IP_PROBE_MARKER,
  createIpProbeHandler,
  hashNetworkValue,
  hopIsTestNetCanary,
  ipProbeTokenFromEnv,
  isPrivateOrLocalAddress,
  type IpProbeDiagnostic,
} from './ip-probe.js';

const TRUSTED_ORIGIN = 'http://localhost:5173';
const PROBE_TOKEN = 'roomies_test_secret_32_chars_minimum_value';
const WRONG_TOKEN = 'roomies_test_secret_32_chars_minimum_wrong';
const CANARY_A = '198.51.100.123';
const CANARY_B = '203.0.113.10';
const CANARY_C = '192.0.2.9';
const PUBLIC_NON_CANARY = '8.8.8.8';

const RAW_NETWORK_SENTINELS = [
  CANARY_A,
  CANARY_B,
  CANARY_C,
  PUBLIC_NON_CANARY,
  'X-Forwarded-For',
  'X-Real-IP',
  'CF-Connecting-IP',
  'Authorization',
  'cookie-secret',
  PROBE_TOKEN,
  WRONG_TOKEN,
] as const;

function expectedHash(value: string): string {
  return createHash('sha256')
    .update(value)
    .digest('hex')
    .slice(0, IP_PROBE_HASH_LENGTH);
}

function mountProbe(trustProxyHops = 0) {
  return createApp({
    config: { trustedOrigins: [TRUSTED_ORIGIN], trustProxyHops },
    readiness: { checkReady: () => Promise.resolve(true) },
    configure(app) {
      app.get(
        IP_PROBE_PATH,
        createIpProbeHandler({ token: PROBE_TOKEN, trustProxyHops }),
      );
    },
  });
}

function unmountedApp() {
  return createApp({
    config: { trustedOrigins: [TRUSTED_ORIGIN], trustProxyHops: 0 },
    readiness: { checkReady: () => Promise.resolve(true) },
  });
}

function asDiagnostic(body: unknown): IpProbeDiagnostic {
  return body as IpProbeDiagnostic;
}

function assertSafeUnknownRoute(res: {
  status: number;
  headers: Headers;
  text: string;
  json: () => unknown;
}): void {
  assert.equal(res.status, 404);
  const body = res.json() as ApiErrorBody;
  assert.equal(body.error.code, 'NOT_FOUND');
  assert.equal(body.error.message, 'Not found');
  assert.equal(body.error.requestId, res.headers.get(REQUEST_ID_HEADER));
  assert.equal(res.text.includes('ip-probe'), false);
  assert.equal(res.text.includes('IP_PROBE'), false);
  assert.equal(res.text.includes('diag'), false);
}

void describe('temporary production IP probe', () => {
  void it('does not mount the route when IP_PROBE_TOKEN is unset', async () => {
    assert.equal(ipProbeTokenFromEnv({}), undefined);
    assert.equal(ipProbeTokenFromEnv({ IP_PROBE_TOKEN: undefined }), undefined);
    assert.equal(ipProbeTokenFromEnv({ IP_PROBE_TOKEN: '   ' }), undefined);

    const res = await appRequest(unmountedApp(), {
      path: IP_PROBE_PATH,
      headers: { [IP_PROBE_TOKEN_HEADER]: PROBE_TOKEN },
    });
    assertSafeUnknownRoute(res);
  });

  void it('rejects a present but low-entropy IP_PROBE_TOKEN without echoing it', () => {
    const weak = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    assert.throws(
      () => ipProbeTokenFromEnv({ IP_PROBE_TOKEN: weak }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /IP_PROBE_TOKEN must be a high-entropy/);
        assert.equal(error.message.includes(weak), false);
        return true;
      },
    );
    assert.equal(
      ipProbeTokenFromEnv({ IP_PROBE_TOKEN: PROBE_TOKEN }),
      PROBE_TOKEN,
    );
  });

  void it('returns the ordinary 404 when the probe token header is missing', async () => {
    const unknown = await appRequest(unmountedApp(), {
      path: '/no-such-route',
    });
    const res = await appRequest(mountProbe(), { path: IP_PROBE_PATH });
    assertSafeUnknownRoute(res);
    assert.equal(res.status, unknown.status);
    assert.equal(
      (res.json() as ApiErrorBody).error.code,
      (unknown.json() as ApiErrorBody).error.code,
    );
    assert.equal(
      (res.json() as ApiErrorBody).error.message,
      (unknown.json() as ApiErrorBody).error.message,
    );
  });

  void it('returns the ordinary 404 when the probe token is wrong or malformed', async () => {
    const app = mountProbe();
    const wrong = await appRequest(app, {
      path: IP_PROBE_PATH,
      headers: { [IP_PROBE_TOKEN_HEADER]: WRONG_TOKEN },
    });
    assertSafeUnknownRoute(wrong);
    assertNoForbiddenLeak({
      context: 'wrong token response',
      text: wrong.text,
      forbidden: RAW_NETWORK_SENTINELS,
    });

    const empty = await appRequest(app, {
      path: IP_PROBE_PATH,
      headers: { [IP_PROBE_TOKEN_HEADER]: '' },
    });
    assertSafeUnknownRoute(empty);

    const short = await appRequest(app, {
      path: IP_PROBE_PATH,
      headers: { [IP_PROBE_TOKEN_HEADER]: 'nope' },
    });
    assertSafeUnknownRoute(short);
  });

  void it('returns hashed diagnostics for a correct token and never echoes raw network values', async () => {
    const app = mountProbe(0);
    const res = await appRequest(app, {
      path: IP_PROBE_PATH,
      headers: {
        [IP_PROBE_TOKEN_HEADER]: PROBE_TOKEN,
        'X-Forwarded-For': `${CANARY_A}, ${CANARY_B}`,
        'X-Real-IP': CANARY_C,
        'CF-Connecting-IP': PUBLIC_NON_CANARY,
        Cookie: 'cookie-secret=1',
        Authorization: 'Bearer cookie-secret',
        Origin: 'https://evil.example',
      },
    });
    assert.equal(res.status, 200);
    const body = asDiagnostic(res.json());
    assert.equal(body.trustProxyHops, 0);
    assert.equal(body.xffHopCount, 2);
    assert.deepEqual(body.hopHashes, [
      expectedHash(CANARY_A),
      expectedHash(CANARY_B),
    ]);
    assert.equal(body.reqIpHash, hashNetworkValue('127.0.0.1'));
    assert.deepEqual(body.reqIpsHashes, []);
    assert.equal(body.xRealIpHash, expectedHash(CANARY_C));
    assert.equal(body.cfConnectingIpHash, expectedHash(PUBLIC_NON_CANARY));
    assert.equal(body.socketRemoteIsPrivate, true);
    assert.equal(body.canaryInXff, true);
    assert.equal(body.canaryInXRealIp, true);
    assert.equal(body.reqIpMatchesLeftmostXff, false);
    assert.equal(body.reqIpMatchesRightmostXff, false);
    assert.equal(body.reqIpMatchesXRealIp, false);
    assert.equal(body.reqIpMatchesCfConnectingIp, false);
    assert.equal(body.xRealIpMatchesCfConnectingIp, false);
    assert.equal(body.edgeAuthSucceeded, false);
    assert.equal(body.trustedLimiterIdentityHash, body.reqIpHash);
    assert.equal(body.trustedIdentityMatchesCfConnectingIp, false);
    assert.equal(body.trustedIdentityMatchesXffIntermediary, false);
    assert.equal(body.canaryInCfConnectingIp, false);
    assert.equal(hashNetworkValue(CANARY_A), expectedHash(CANARY_A));
    assert.equal(expectedHash(CANARY_A).length, IP_PROBE_HASH_LENGTH);

    assertNoForbiddenLeak({
      context: 'authorized probe response',
      text: res.text,
      forbidden: [
        ...COMMON_SECRET_SENTINELS,
        ...RAW_NETWORK_SENTINELS,
        '127.0.0.1',
        '::1',
        'x-forwarded-for',
        'cf-connecting-ip',
      ],
    });
  });

  void it('is GET only even with a correct token', async () => {
    const app = mountProbe();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await appRequest(app, {
        method,
        path: IP_PROBE_PATH,
        headers: { [IP_PROBE_TOKEN_HEADER]: PROBE_TOKEN },
      });
      assertSafeUnknownRoute(res);
    }
  });

  void it('does not log diagnostic network values', async () => {
    const logs: string[] = [];
    const original = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
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
    console.debug = capture('debug');

    try {
      const res = await appRequest(mountProbe(), {
        path: IP_PROBE_PATH,
        headers: {
          [IP_PROBE_TOKEN_HEADER]: PROBE_TOKEN,
          'X-Forwarded-For': CANARY_A,
          'X-Real-IP': CANARY_B,
        },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(logs, []);
      assertNoForbiddenLeak({
        context: 'probe stdout',
        text: logs.join('\n'),
        forbidden: RAW_NETWORK_SENTINELS,
      });
    } finally {
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
      console.debug = original.debug;
    }
  });

  void it('does not change trust-proxy selection of req.ip', async () => {
    await withAppServer(mountProbe(0), async (request) => {
      const direct = await request({
        path: IP_PROBE_PATH,
        headers: { [IP_PROBE_TOKEN_HEADER]: PROBE_TOKEN },
      });
      const spoofed = await request({
        path: IP_PROBE_PATH,
        headers: {
          [IP_PROBE_TOKEN_HEADER]: PROBE_TOKEN,
          'X-Forwarded-For': `${CANARY_A}, ${CANARY_B}`,
        },
      });
      const directBody = asDiagnostic(direct.json());
      const spoofedBody = asDiagnostic(spoofed.json());
      assert.equal(direct.status, 200);
      assert.equal(spoofed.status, 200);
      assert.equal(spoofedBody.reqIpHash, directBody.reqIpHash);
      assert.deepEqual(spoofedBody.reqIpsHashes, []);
      assert.equal(spoofedBody.canaryInXff, true);
      assert.equal(spoofedBody.reqIpMatchesLeftmostXff, false);
    });

    const trusted = await appRequest(mountProbe(1), {
      path: IP_PROBE_PATH,
      headers: {
        [IP_PROBE_TOKEN_HEADER]: PROBE_TOKEN,
        'X-Forwarded-For': `${CANARY_A}, ${CANARY_B}`,
      },
    });
    const trustedBody = asDiagnostic(trusted.json());
    assert.equal(trusted.status, 200);
    assert.equal(trustedBody.trustProxyHops, 1);
    assert.equal(trustedBody.reqIpHash, expectedHash(CANARY_B));
    assert.deepEqual(trustedBody.reqIpsHashes, [expectedHash(CANARY_B)]);
    assert.equal(trustedBody.reqIpMatchesRightmostXff, true);
    assert.equal(trustedBody.reqIpMatchesLeftmostXff, false);
  });

  void it('classifies TEST-NET canaries and private/CGNAT sockets only', () => {
    assert.equal(hopIsTestNetCanary(CANARY_A), true);
    assert.equal(hopIsTestNetCanary(CANARY_B), true);
    assert.equal(hopIsTestNetCanary(CANARY_C), true);
    assert.equal(hopIsTestNetCanary('::ffff:198.51.100.1'), true);
    assert.equal(hopIsTestNetCanary(PUBLIC_NON_CANARY), false);
    assert.equal(hopIsTestNetCanary('10.0.0.1'), false);
    assert.equal(isPrivateOrLocalAddress('127.0.0.1'), true);
    assert.equal(isPrivateOrLocalAddress('::1'), true);
    assert.equal(isPrivateOrLocalAddress('::ffff:100.64.1.2'), true);
    assert.equal(isPrivateOrLocalAddress('10.1.2.3'), true);
    assert.equal(isPrivateOrLocalAddress(CANARY_A), false);
    assert.equal(isPrivateOrLocalAddress(PUBLIC_NON_CANARY), false);
  });

  void it('does not write trust-proxy or log network values in the probe module', async () => {
    const source = await readFile(
      fileURLToPath(import.meta.url).replace(/\.test\.ts$/u, '.ts'),
      'utf8',
    );
    assert.match(source, new RegExp(TEMPORARY_PRODUCTION_IP_PROBE_MARKER));
    assert.doesNotMatch(source, /app\.set\(\s*['"]trust proxy['"]/);
    assert.doesNotMatch(source, /process\.env\.TRUST_PROXY/);
    assert.doesNotMatch(source, /console\.(log|info|warn|error|debug)/);
    assert.doesNotMatch(source, /198\.51\.100/);
    assert.doesNotMatch(source, /203\.0\.113/);
    assert.doesNotMatch(source, /192\.0\.2/);
  });
});
