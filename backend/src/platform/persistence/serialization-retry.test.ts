import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TransactionInfrastructureError } from './errors.js';
import {
  isPostgresSerializationFailure,
  runWithBoundedSerializationRetry,
  SERIALIZATION_RETRY_MAX_ATTEMPTS,
} from './serialization-retry.js';

void describe('bounded serialization retry', () => {
  void it('retries SQLSTATE 40001 and succeeds on a later attempt', async () => {
    let attempts = 0;
    const value = await runWithBoundedSerializationRetry(() => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(
          Object.assign(new Error('could not serialize access'), {
            code: '40001',
          }),
        );
      }
      return Promise.resolve('ok');
    });
    assert.equal(value, 'ok');
    assert.equal(attempts, 2);
    assert.equal(SERIALIZATION_RETRY_MAX_ATTEMPTS, 3);
  });

  void it('maps exhausted serialization failures to infrastructure errors', async () => {
    await assert.rejects(
      () =>
        runWithBoundedSerializationRetry(() =>
          Promise.reject(
            Object.assign(new Error('could not serialize access'), {
              code: '40001',
            }),
          ),
        ),
      (error: unknown) => {
        assert.ok(error instanceof TransactionInfrastructureError);
        assert.equal(String(error).includes('serialize'), false);
        assert.equal(String(error).includes('40001'), false);
        return true;
      },
    );
  });

  void it('does not retry unrelated errors', async () => {
    const original = new Error('application boom');
    await assert.rejects(
      () => runWithBoundedSerializationRetry(() => Promise.reject(original)),
      (error: unknown) => error === original,
    );
    assert.equal(isPostgresSerializationFailure({ code: '40001' }), true);
    assert.equal(isPostgresSerializationFailure({ code: '40P01' }), false);
  });
});
