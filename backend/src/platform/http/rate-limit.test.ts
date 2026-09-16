import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_RATE_LIMITS,
  createInMemoryRateLimitRuntime,
} from './rate-limit.js';

function createFakeClock(startMs: number) {
  let current = startMs;
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
    },
  };
}

void describe('in-memory rate-limit store', () => {
  void it('allows requests below the limit and rejects the next', () => {
    const clock = createFakeClock(1_000_000);
    const runtime = createInMemoryRateLimitRuntime({
      clock,
      policies: { credential: { max: 3, windowMs: 60_000 } },
    });

    assert.equal(runtime.consume('credential', 'ip-a').allowed, true);
    assert.equal(runtime.consume('credential', 'ip-a').allowed, true);
    assert.equal(runtime.consume('credential', 'ip-a').allowed, true);
    const blocked = runtime.consume('credential', 'ip-a');
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSeconds >= 1);
    runtime.stop();
  });

  void it('keeps separate identities in separate buckets', () => {
    const runtime = createInMemoryRateLimitRuntime({
      policies: { credential: { max: 1, windowMs: 60_000 } },
    });

    assert.equal(runtime.consume('credential', 'ip-a').allowed, true);
    assert.equal(runtime.consume('credential', 'ip-a').allowed, false);
    assert.equal(runtime.consume('credential', 'ip-b').allowed, true);
    runtime.stop();
  });

  void it('does not share buckets across limiter classes', () => {
    const runtime = createInMemoryRateLimitRuntime({
      policies: {
        credential: { max: 1, windowMs: 60_000 },
        sensitive: { max: 1, windowMs: 60_000 },
      },
    });

    assert.equal(runtime.consume('credential', 'same').allowed, true);
    assert.equal(runtime.consume('credential', 'same').allowed, false);
    assert.equal(runtime.consume('sensitive', 'same').allowed, true);
    runtime.stop();
  });

  void it('resets after the window using injected time', () => {
    const clock = createFakeClock(5_000_000);
    const runtime = createInMemoryRateLimitRuntime({
      clock,
      policies: { credential: { max: 1, windowMs: 10_000 } },
    });

    assert.equal(runtime.consume('credential', 'ip-a').allowed, true);
    assert.equal(runtime.consume('credential', 'ip-a').allowed, false);
    clock.advance(10_001);
    assert.equal(runtime.consume('credential', 'ip-a').allowed, true);
    runtime.stop();
  });

  void it('removes expired buckets on sweep', () => {
    const clock = createFakeClock(8_000_000);
    const runtime = createInMemoryRateLimitRuntime({
      clock,
      policies: { credential: { max: 2, windowMs: 5_000 } },
    });

    assert.equal(runtime.consume('credential', 'ip-a').allowed, true);
    assert.equal(runtime.bucketCount(), 1);
    clock.advance(5_001);
    runtime.sweepExpired();
    assert.equal(runtime.bucketCount(), 0);
    runtime.stop();
  });

  void it('fails closed when attacker-controlled keys exceed the bound', () => {
    const runtime = createInMemoryRateLimitRuntime({
      maxKeys: 3,
      policies: { credential: { max: 5, windowMs: 60_000 } },
    });

    assert.equal(runtime.consume('credential', 'k1').allowed, true);
    assert.equal(runtime.consume('credential', 'k2').allowed, true);
    assert.equal(runtime.consume('credential', 'k3').allowed, true);
    const overflow = runtime.consume('credential', 'k4');
    assert.equal(overflow.allowed, false);
    assert.equal(runtime.bucketCount(), 3);
    assert.equal(runtime.consume('credential', 'k1').allowed, true);
    runtime.stop();
  });

  void it('documents the October default policies', () => {
    assert.deepEqual(DEFAULT_RATE_LIMITS.credential, {
      max: 20,
      windowMs: 15 * 60 * 1000,
    });
    assert.deepEqual(DEFAULT_RATE_LIMITS.sensitive, {
      max: 10,
      windowMs: 15 * 60 * 1000,
    });
    assert.deepEqual(DEFAULT_RATE_LIMITS.invitation_token, {
      max: 30,
      windowMs: 15 * 60 * 1000,
    });
  });
});
