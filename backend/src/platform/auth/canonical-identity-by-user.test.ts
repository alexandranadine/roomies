import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuthInfrastructureError } from './errors.js';
import { findCurrentCanonicalIdentityByUser } from './canonical-identity-by-user.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

function databaseRows(rows: readonly unknown[]) {
  return {
    query: <T>() => Promise.resolve({ rows: [...rows] as T[] }),
  };
}

void describe('findCurrentCanonicalIdentityByUser', () => {
  void it('returns current normalized email and verification truth', async () => {
    const identity = await findCurrentCanonicalIdentityByUser(
      databaseRows([
        {
          id: USER_ID,
          email: 'roommate@example.com',
          email_verified: true,
          has_user: true,
        },
      ]),
      USER_ID,
    );
    assert.deepEqual(identity, {
      userId: USER_ID,
      email: 'roommate@example.com',
      emailVerified: true,
    });
  });

  void it('keeps an existing unverified identity distinguishable from missing', async () => {
    const unverified = await findCurrentCanonicalIdentityByUser(
      databaseRows([
        {
          id: USER_ID,
          email: 'roommate@example.com',
          email_verified: false,
          has_user: true,
        },
      ]),
      USER_ID,
    );
    assert.equal(unverified?.emailVerified, false);

    const missing = await findCurrentCanonicalIdentityByUser(
      databaseRows([]),
      USER_ID,
    );
    assert.equal(missing, null);
  });

  void it('fails closed on noncanonical or detached identity rows', async () => {
    for (const row of [
      {
        id: USER_ID,
        email: 'Roommate@example.com',
        email_verified: true,
        has_user: true,
      },
      {
        id: USER_ID,
        email: 'roommate@example.com',
        email_verified: true,
        has_user: false,
      },
    ]) {
      await assert.rejects(
        findCurrentCanonicalIdentityByUser(databaseRows([row]), USER_ID),
        AuthInfrastructureError,
      );
    }
  });
});
