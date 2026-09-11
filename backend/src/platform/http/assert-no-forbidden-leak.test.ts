import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertNoForbiddenLeak,
  COMMON_SECRET_SENTINELS,
} from './assert-no-forbidden-leak.js';

void describe('assertNoForbiddenLeak', () => {
  void it('passes when no sentinel appears', () => {
    assert.doesNotThrow(() =>
      assertNoForbiddenLeak({
        context: 'response body',
        text: JSON.stringify({
          error: { message: 'An unexpected error occurred' },
        }),
        forbidden: COMMON_SECRET_SENTINELS,
      }),
    );
  });

  void it('fails when a sentinel leaks', () => {
    assert.throws(
      () =>
        assertNoForbiddenLeak({
          context: 'response body',
          text: 'connection failed postgresql://roomies:x@host/db',
          forbidden: COMMON_SECRET_SENTINELS,
        }),
      /Forbidden leak/,
    );
  });
});
