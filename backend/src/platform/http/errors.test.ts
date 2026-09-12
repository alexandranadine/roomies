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
  InvalidRequestError,
} from '../authz/errors.js';
import { StructuralIntegrityError } from '../../domains/homes/structure-errors.js';
import {
  AlreadyHomeMemberError,
  InvitationAlreadyPendingError,
  InvitationValidityConflictError,
} from '../../domains/invitations/errors.js';
import {
  LastAdminRequiredError,
  LastRoommateRequiresArchiveError,
} from '../../domains/memberships/errors.js';
import { TransactionInfrastructureError } from '../persistence/errors.js';
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

  void it('maps InvalidRequestError to 400 INVALID_REQUEST', async () => {
    const res = await appRequest(appThatThrows(new InvalidRequestError()), {
      path: '/throw',
    });
    assert.equal(res.status, 400);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'INVALID_REQUEST');
    assert.equal(body.error.message, 'Invalid request');
  });

  void it('maps LastAdminRequiredError to 409 LAST_ADMIN_REQUIRED', async () => {
    const res = await appRequest(appThatThrows(new LastAdminRequiredError()), {
      path: '/throw',
    });
    assert.equal(res.status, 409);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'LAST_ADMIN_REQUIRED');
    assert.equal(body.error.message, 'Last admin required');
  });

  void it('maps LastRoommateRequiresArchiveError to 409 LAST_ROOMMATE_REQUIRES_ARCHIVE', async () => {
    const res = await appRequest(
      appThatThrows(new LastRoommateRequiresArchiveError()),
      { path: '/throw' },
    );
    assert.equal(res.status, 409);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'LAST_ROOMMATE_REQUIRES_ARCHIVE');
    assert.equal(body.error.message, 'Last roommate requires archive');
  });

  void it('maps InvitationAlreadyPendingError to 409 INVITATION_ALREADY_PENDING', async () => {
    const res = await appRequest(
      appThatThrows(new InvitationAlreadyPendingError()),
      { path: '/throw' },
    );
    assert.equal(res.status, 409);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'INVITATION_ALREADY_PENDING');
    assert.equal(body.error.message, 'Invitation already pending');
  });

  void it('does not map InvitationValidityConflictError to a pending 409', async () => {
    const res = await appRequest(
      appThatThrows(new InvitationValidityConflictError()),
      { path: '/throw' },
    );
    assert.equal(res.status, 500);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.notEqual(body.error.code, 'INVITATION_ALREADY_PENDING');
  });

  void it('maps AlreadyHomeMemberError to 409 ALREADY_HOME_MEMBER', async () => {
    const res = await appRequest(appThatThrows(new AlreadyHomeMemberError()), {
      path: '/throw',
    });
    assert.equal(res.status, 409);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'ALREADY_HOME_MEMBER');
    assert.equal(body.error.message, 'Already a home member');
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

  void it('maps StructuralIntegrityError to a safe 500', async () => {
    const res = await appRequest(
      appThatThrows(new StructuralIntegrityError()),
      {
        path: '/throw',
      },
    );
    assert.equal(res.status, 500);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.equal(body.error.message, 'An unexpected error occurred');
    assert.equal(res.text.includes('Home structure integrity failure'), false);
  });

  void it('maps TransactionInfrastructureError to a safe 500', async () => {
    const res = await appRequest(
      appThatThrows(new TransactionInfrastructureError()),
      { path: '/throw' },
    );
    assert.equal(res.status, 500);
    const body = res.json() as ApiErrorBody;
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.equal(body.error.message, 'An unexpected error occurred');
    assert.equal(
      res.text.includes('Transaction infrastructure failure'),
      false,
    );
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
