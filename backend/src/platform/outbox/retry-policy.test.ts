import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_RETRY_BACKOFF_BASE_MS,
  OUTBOX_RETRY_BACKOFF_MAX_MS,
  outboxRetryBackoffMs,
} from './retry-policy.js';

void describe('outboxRetryBackoffMs', () => {
  void it('uses 1s 2s 4s 8s exponential steps capped at 60s', () => {
    assert.equal(outboxRetryBackoffMs(1), 1_000);
    assert.equal(outboxRetryBackoffMs(2), 2_000);
    assert.equal(outboxRetryBackoffMs(3), 4_000);
    assert.equal(outboxRetryBackoffMs(4), 8_000);
    assert.equal(outboxRetryBackoffMs(5), 16_000);
    assert.equal(outboxRetryBackoffMs(6), 32_000);
    assert.equal(outboxRetryBackoffMs(7), 60_000);
    assert.equal(outboxRetryBackoffMs(8), 60_000);
    assert.equal(OUTBOX_RETRY_BACKOFF_BASE_MS, 1_000);
    assert.equal(OUTBOX_RETRY_BACKOFF_MAX_MS, 60_000);
    assert.equal(OUTBOX_MAX_ATTEMPTS, 8);
  });
});
