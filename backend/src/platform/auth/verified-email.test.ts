import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { AuthInfrastructureError } from './errors.js';
import { createVerifiedEmailLookup } from './verified-email.js';

const USER_ID = '018f3a5b-7c8d-7abc-8def-0123456789ab';

function poolReturning(rows: unknown[]): Pool {
  return {
    query: () => Promise.resolve({ rows }),
  } as unknown as Pool;
}

void describe('createVerifiedEmailLookup', () => {
  void it('returns the current canonical verified identity', async () => {
    const lookup = createVerifiedEmailLookup(
      poolReturning([{ id: USER_ID, email: 'person+home@example.com' }]),
    );
    assert.deepEqual(await lookup(USER_ID), {
      userId: USER_ID,
      email: 'person+home@example.com',
    });
  });

  void it('returns null when no verified identity exists', async () => {
    const lookup = createVerifiedEmailLookup(poolReturning([]));
    assert.equal(await lookup(USER_ID), null);
  });

  void it('fails closed on noncanonical identity data', async () => {
    const lookup = createVerifiedEmailLookup(
      poolReturning([{ id: USER_ID, email: ' Person@example.com ' }]),
    );
    await assert.rejects(() => lookup(USER_ID), AuthInfrastructureError);
  });
});
