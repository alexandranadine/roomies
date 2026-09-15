import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TransactionInfrastructureError } from '../persistence/errors.js';
import type { TransactionContext } from '../persistence/transaction.js';
import { normalizeEmail } from '../../../auth-runtime/src/index.js';
import { AuthInfrastructureError } from './errors.js';
import {
  authLifecycleIdentityFromCurrent,
  createAuthIdentityTeardownPersistence,
  DELETE_ATTRIBUTABLE_AUTH_VERIFICATIONS_SQL,
  DELETE_AUTH_IDENTITY_SQL,
} from './auth-identity-teardown.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const EMAIL = normalizeEmail('roommate@example.test');

function recordingTx(
  responses: Array<{ rowCount: number | null }> = [
    { rowCount: 0 },
    { rowCount: 1 },
  ],
): {
  tx: TransactionContext;
  calls: Array<{ text: string; values: readonly unknown[] | undefined }>;
} {
  const calls: Array<{ text: string; values: readonly unknown[] | undefined }> =
    [];
  let index = 0;
  return {
    calls,
    tx: {
      query: (text, values) => {
        calls.push({ text, values });
        const response = responses[index] ?? { rowCount: 1 };
        index += 1;
        return Promise.resolve({ rows: [], rowCount: response.rowCount });
      },
    },
  };
}

void describe('createAuthIdentityTeardownPersistence', () => {
  void it('deletes attributable verifications then AuthIdentity in the caller transaction', async () => {
    const { tx, calls } = recordingTx();
    await createAuthIdentityTeardownPersistence().teardownAuthForIdentity(tx, {
      userId: USER_ID,
      email: EMAIL,
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.text, DELETE_ATTRIBUTABLE_AUTH_VERIFICATIONS_SQL);
    assert.deepEqual(calls[0]?.values, [USER_ID, EMAIL]);
    assert.equal(calls[1]?.text, DELETE_AUTH_IDENTITY_SQL);
    assert.deepEqual(calls[1]?.values, [USER_ID, EMAIL]);
    assert.match(
      DELETE_ATTRIBUTABLE_AUTH_VERIFICATIONS_SQL,
      /DELETE FROM auth_verifications/,
    );
    assert.match(
      DELETE_ATTRIBUTABLE_AUTH_VERIFICATIONS_SQL,
      /value = \$1::text/,
    );
    assert.match(
      DELETE_ATTRIBUTABLE_AUTH_VERIFICATIONS_SQL,
      /identifier = \$2::text/,
    );
    assert.doesNotMatch(DELETE_ATTRIBUTABLE_AUTH_VERIFICATIONS_SQL, /LIKE/i);
    assert.doesNotMatch(DELETE_ATTRIBUTABLE_AUTH_VERIFICATIONS_SQL, /ILIKE/i);
    assert.match(DELETE_AUTH_IDENTITY_SQL, /DELETE FROM auth_identities/);
    assert.match(DELETE_AUTH_IDENTITY_SQL, /id = \$1::uuid/);
    assert.match(DELETE_AUTH_IDENTITY_SQL, /email = \$2/);
    assert.doesNotMatch(DELETE_AUTH_IDENTITY_SQL, /DELETE FROM auth_accounts/i);
    assert.doesNotMatch(DELETE_AUTH_IDENTITY_SQL, /DELETE FROM auth_sessions/i);
    assert.doesNotMatch(DELETE_AUTH_IDENTITY_SQL, /FROM users/i);
    assert.doesNotMatch(DELETE_AUTH_IDENTITY_SQL, /memberships/i);
    assert.doesNotMatch(DELETE_AUTH_IDENTITY_SQL, /BEGIN/i);
    assert.doesNotMatch(DELETE_AUTH_IDENTITY_SQL, /COMMIT/i);
    assert.doesNotMatch(DELETE_ATTRIBUTABLE_AUTH_VERIFICATIONS_SQL, /BEGIN/i);
    assert.doesNotMatch(DELETE_ATTRIBUTABLE_AUTH_VERIFICATIONS_SQL, /COMMIT/i);
  });

  void it('fails closed when AuthIdentity is not deleted', async () => {
    const { tx } = recordingTx([{ rowCount: 0 }, { rowCount: 0 }]);
    await assert.rejects(
      () =>
        createAuthIdentityTeardownPersistence().teardownAuthForIdentity(tx, {
          userId: USER_ID,
          email: EMAIL,
        }),
      AuthInfrastructureError,
    );
  });

  void it('maps query failures without leaking identity material', async () => {
    const tx: TransactionContext = {
      query: () =>
        Promise.reject(new Error(`SELECT token FROM auth_sessions ${EMAIL}`)),
    };

    await assert.rejects(
      () =>
        createAuthIdentityTeardownPersistence().teardownAuthForIdentity(tx, {
          userId: USER_ID,
          email: EMAIL,
        }),
      (error: unknown) => {
        assert.ok(error instanceof TransactionInfrastructureError);
        assert.equal(error.message.includes(EMAIL), false);
        assert.equal(error.message.includes(USER_ID), false);
        assert.equal(error.message.includes('token'), false);
        return true;
      },
    );
  });

  void it('rejects noncanonical captured identity without querying', async () => {
    const { tx, calls } = recordingTx();
    await assert.rejects(
      () =>
        createAuthIdentityTeardownPersistence().teardownAuthForIdentity(tx, {
          userId: 'not-a-uuid',
          email: EMAIL,
        }),
      AuthInfrastructureError,
    );
    await assert.rejects(
      () =>
        createAuthIdentityTeardownPersistence().teardownAuthForIdentity(tx, {
          userId: USER_ID,
          email: 'Roommate@example.test' as typeof EMAIL,
        }),
      AuthInfrastructureError,
    );
    assert.deepEqual(calls, []);
  });

  void it('projects lifecycle identity from the current canonical identity', () => {
    assert.deepEqual(
      authLifecycleIdentityFromCurrent({
        userId: USER_ID,
        email: EMAIL,
        emailVerified: true,
      }),
      { userId: USER_ID, email: EMAIL },
    );
  });
});
