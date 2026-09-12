import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertNoNormalizedEmailCollisions,
  NormalizedEmailCollisionError,
  type EmailCollisionQuery,
} from './normalized-email-collision-audit.js';

function queryReturning(ids: unknown[]): EmailCollisionQuery {
  return {
    query<T>() {
      return Promise.resolve({
        rows: ids.map((value) => ({ ids: value })) as T[],
      });
    },
  };
}

void describe('assertNoNormalizedEmailCollisions', () => {
  void it('passes an empty collision audit', async () => {
    await assert.doesNotReject(
      assertNoNormalizedEmailCollisions(queryReturning([])),
    );
  });

  void it('refuses migration state with colliding identity IDs', async () => {
    const ids = [
      '018f3a5b-7c8d-7abc-8def-0123456789ab',
      '018f3a5b-7c8d-7abc-8def-0123456789ac',
    ];
    await assert.rejects(
      assertNoNormalizedEmailCollisions(queryReturning([ids])),
      (error: unknown) =>
        error instanceof NormalizedEmailCollisionError &&
        error.collisionIds[0]?.join(',') === ids.join(','),
    );
  });
});
