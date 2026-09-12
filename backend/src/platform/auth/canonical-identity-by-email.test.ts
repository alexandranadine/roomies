import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeEmail } from '../../../auth-runtime/src/index.js';
import {
  createCanonicalIdentityByEmailLookup,
  findCanonicalIdentityByEmail,
  type CanonicalIdentityQuery,
} from './canonical-identity-by-email.js';
import { AuthInfrastructureError } from './errors.js';

const USER_ID = '018f3a5b-7c8d-7abc-8def-0123456789ab';
const EMAIL = normalizeEmail('roommate+home@example.com');

function queryOf(rows: unknown[]): CanonicalIdentityQuery {
  return {
    query<T>() {
      return Promise.resolve({ rows: rows as T[] });
    },
  };
}

void describe('findCanonicalIdentityByEmail', () => {
  void it('returns the unique canonical identity', async () => {
    const identity = await findCanonicalIdentityByEmail(
      queryOf([{ id: USER_ID, email: EMAIL, has_user: true }]),
      EMAIL,
    );
    assert.deepEqual(identity, { userId: USER_ID, email: EMAIL });
  });

  void it('returns null when no account exists', async () => {
    assert.equal(await findCanonicalIdentityByEmail(queryOf([]), EMAIL), null);
  });

  void it('fails closed on ambiguous, missing-user, or noncanonical rows', async () => {
    await assert.rejects(
      () =>
        findCanonicalIdentityByEmail(
          queryOf([
            { id: USER_ID, email: EMAIL, has_user: true },
            {
              id: '018f3a5b-7c8d-7abc-8def-0123456789ac',
              email: EMAIL,
              has_user: true,
            },
          ]),
          EMAIL,
        ),
      AuthInfrastructureError,
    );
    await assert.rejects(
      () =>
        findCanonicalIdentityByEmail(
          queryOf([{ id: USER_ID, email: EMAIL, has_user: false }]),
          EMAIL,
        ),
      AuthInfrastructureError,
    );
    await assert.rejects(
      () =>
        findCanonicalIdentityByEmail(
          queryOf([
            { id: USER_ID, email: ' Person@example.com ', has_user: true },
          ]),
          EMAIL,
        ),
      AuthInfrastructureError,
    );
  });

  void it('exposes a lookup factory over the same authority', async () => {
    const lookup = createCanonicalIdentityByEmailLookup(
      queryOf([{ id: USER_ID, email: EMAIL, has_user: true }]),
    );
    assert.deepEqual(await lookup(EMAIL), { userId: USER_ID, email: EMAIL });
  });
});
