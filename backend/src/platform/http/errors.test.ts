import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AuthInfrastructureError,
  UnauthenticatedError,
} from '../auth/errors.js';
import {
  AuthorizationIntegrityError,
  ConcealedNotFoundError,
  ForbiddenError,
  InvalidPathInputError,
} from '../authz/errors.js';
import { appRequest } from './app-request.test-helper.js';
import {
  assertNoForbiddenLeak,
  COMMON_SECRET_SENTINELS,
} from './assert-no-forbidden-leak.js';
import { REQUEST_ID_HEADER } from './constants.js';
import { createApp } from './create-app.js';
import type { ApiErrorBody } from './errors.js';

function appThatThrows(error: unknown) {
  return createApp({
    config: { trustedOrigins: ['http://localhost:5173'], trustProxyHops: 0 },
    readiness: { checkReady: () => Promise.resolve(true) },
    configure(expressApp) {
      expressApp.get('/throw', () => {
        throw error;
      });
    },
  });
}

void describe('HTTP known-error mappings', () => {
  void it('maps UnauthenticatedError to 401 UNAUTHENTICATED', async () => {
    const res = await appRequest(appThatThrows(new UnauthenticatedError()), {
      path: '/throw',
    });
    assert.equal(res.status, 401);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'UNAUTHENTICATED');
    assert.equal(body.error.message, 'Authentication required');
    assert.equal(body.error.requestId, res.headers.get(REQUEST_ID_HEADER));
  });

  void it('maps InvalidPathInputError to 400 INVALID_PATH_INPUT', async () => {
    const res = await appRequest(appThatThrows(new InvalidPathInputError()), {
      path: '/throw',
    });
    assert.equal(res.status, 400);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'INVALID_PATH_INPUT');
    assert.equal(body.error.message, 'Invalid path input');
  });

  void it('maps ForbiddenError to 403 FORBIDDEN', async () => {
    const res = await appRequest(appThatThrows(new ForbiddenError()), {
      path: '/throw',
    });
    assert.equal(res.status, 403);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'FORBIDDEN');
    assert.equal(body.error.message, 'Forbidden');
  });

  void it('maps ConcealedNotFoundError to 404 NOT_FOUND', async () => {
    const res = await appRequest(appThatThrows(new ConcealedNotFoundError()), {
      path: '/throw',
    });
    assert.equal(res.status, 404);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.equal(body.error.message, 'Not found');
  });

  void it('maps AuthorizationIntegrityError to a safe 500', async () => {
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map((value) => JSON.stringify(value)).join(' '));
    };

    try {
      const res = await appRequest(
        appThatThrows(new AuthorizationIntegrityError()),
        { path: '/throw' },
      );
      assert.equal(res.status, 500);
      const body = res.json() as ApiErrorBody;
      assert.equal(body.error.code, 'INTERNAL_ERROR');
      assert.equal(body.error.message, 'An unexpected error occurred');
      assertNoForbiddenLeak({
        context: 'integrity 500 body',
        text: res.text,
        forbidden: [
          ...COMMON_SECRET_SENTINELS,
          'Authorization integrity failure',
          'SELECT',
          'stack',
        ],
      });
      assertNoForbiddenLeak({
        context: 'integrity 500 logs',
        text: logs.join('\n'),
        forbidden: [
          ...COMMON_SECRET_SENTINELS,
          'Authorization integrity failure',
          'SELECT',
        ],
      });
    } finally {
      console.error = originalError;
    }
  });

  void it('maps AuthInfrastructureError to a safe 500', async () => {
    const res = await appRequest(appThatThrows(new AuthInfrastructureError()), {
      path: '/throw',
    });
    assert.equal(res.status, 500);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.equal(body.error.message, 'An unexpected error occurred');
    assert.equal(
      res.text.includes('Authentication infrastructure failure'),
      false,
    );
  });

  void it('does not let arbitrary status/code/message fields control the envelope', async () => {
    const res = await appRequest(
      appThatThrows({
        status: 403,
        statusCode: 403,
        code: 'LEAKED_CODE',
        message: 'secret home 0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee exists',
      }),
      { path: '/throw' },
    );
    assert.equal(res.status, 500);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.equal(body.error.message, 'An unexpected error occurred');
    assertNoForbiddenLeak({
      context: 'hostile status object body',
      text: res.text,
      forbidden: [
        'LEAKED_CODE',
        'secret home',
        '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee',
        'FORBIDDEN',
      ],
    });
  });
});
