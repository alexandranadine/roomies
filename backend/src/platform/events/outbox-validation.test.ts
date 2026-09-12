import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { OutboxEventValidationError } from './errors.js';
import type { RuntimeOutboxEventInput } from './outbox-validation.js';
import {
  MAX_OUTBOX_PAYLOAD_BYTES,
  validateOutboxEventInput,
} from './outbox-validation.js';

const UUID_V7 = '018f1e2c-7e3a-7000-8000-1234567890ab';
const UUID_V4 = '550e8400-e29b-41d4-a716-446655440000';
const OCCURRED_AT = new Date('2026-03-15T12:34:56.789Z');

function validEvent(
  overrides: Partial<RuntimeOutboxEventInput> = {},
): RuntimeOutboxEventInput {
  return {
    eventId: UUID_V7,
    eventType: 'membership.ended.v1',
    occurredAt: OCCURRED_AT,
    payload: {},
    ...overrides,
  };
}

function assertInvalid(
  event: RuntimeOutboxEventInput,
  reason: OutboxEventValidationError['reason'],
): void {
  assert.throws(
    () => validateOutboxEventInput(event),
    (error: unknown) => {
      assert.ok(error instanceof OutboxEventValidationError);
      assert.equal(error.reason, reason);
      assert.equal(error.message, 'Outbox event input is invalid');
      return true;
    },
  );
}

function payloadWithUtf8Bytes(
  byteLength: number,
  fill: string,
): Record<string, string> {
  const emptyBytes = new TextEncoder().encode(JSON.stringify({ d: '' })).length;
  const fillBytes = new TextEncoder().encode(fill).length;
  const remaining = byteLength - emptyBytes;
  assert.equal(remaining >= 0, true);
  assert.equal(remaining % fillBytes, 0);
  const payload = { d: fill.repeat(remaining / fillBytes) };
  const serialized = JSON.stringify(payload);
  assert.equal(new TextEncoder().encode(serialized).length, byteLength);
  return payload;
}

void describe('validateOutboxEventInput', () => {
  void describe('eventId', () => {
    void it('accepts a UUIDv7', () => {
      const validated = validateOutboxEventInput(validEvent());
      assert.equal(validated.eventId, UUID_V7);
    });

    void it('rejects a UUIDv4', () => {
      assertInvalid(validEvent({ eventId: UUID_V4 }), 'INVALID_EVENT_ID');
    });

    void it('rejects randomUUID v4', () => {
      assertInvalid(validEvent({ eventId: randomUUID() }), 'INVALID_EVENT_ID');
    });

    void it('rejects a malformed id', () => {
      assertInvalid(validEvent({ eventId: 'not-a-uuid' }), 'INVALID_EVENT_ID');
    });
  });

  void describe('eventType', () => {
    void it('accepts membership.ended.v1', () => {
      const validated = validateOutboxEventInput(
        validEvent({ eventType: 'membership.ended.v1' }),
      );
      assert.equal(validated.eventType, 'membership.ended.v1');
    });

    void it('accepts membership.role_changed.v1', () => {
      const validated = validateOutboxEventInput(
        validEvent({ eventType: 'membership.role_changed.v1' }),
      );
      assert.equal(validated.eventType, 'membership.role_changed.v1');
    });

    void it('accepts home.archived.v1', () => {
      const validated = validateOutboxEventInput(
        validEvent({ eventType: 'home.archived.v1' }),
      );
      assert.equal(validated.eventType, 'home.archived.v1');
    });

    void it('rejects a missing version', () => {
      assertInvalid(
        validEvent({ eventType: 'membership.ended' }),
        'INVALID_EVENT_TYPE',
      );
    });

    void it('rejects uppercase', () => {
      assertInvalid(
        validEvent({ eventType: 'Membership.ended.v1' }),
        'INVALID_EVENT_TYPE',
      );
    });

    void it('rejects a malformed segment', () => {
      assertInvalid(
        validEvent({ eventType: 'membership.-ended.v1' }),
        'INVALID_EVENT_TYPE',
      );
    });

    void it('rejects v0', () => {
      assertInvalid(
        validEvent({ eventType: 'membership.ended.v0' }),
        'INVALID_EVENT_TYPE',
      );
    });
  });

  void describe('occurredAt', () => {
    void it('accepts a valid Date', () => {
      const validated = validateOutboxEventInput(validEvent());
      assert.equal(validated.occurredAt, OCCURRED_AT);
    });

    void it('rejects an Invalid Date without substituting now()', () => {
      const before = Date.now();
      assertInvalid(
        validEvent({ occurredAt: new Date(Number.NaN) }),
        'INVALID_OCCURRED_AT',
      );
      const after = Date.now();
      assert.equal(after - before < 1_000, true);
    });
  });

  void describe('homeId', () => {
    void it('accepts an omitted homeId', () => {
      const validated = validateOutboxEventInput(validEvent());
      assert.equal(validated.homeId, null);
    });

    void it('accepts a valid UUID of any version', () => {
      const validated = validateOutboxEventInput(
        validEvent({ homeId: UUID_V4 }),
      );
      assert.equal(validated.homeId, UUID_V4);
    });

    void it('rejects a malformed homeId', () => {
      assertInvalid(validEvent({ homeId: 'not-a-uuid' }), 'INVALID_HOME_ID');
    });
  });

  void describe('payload', () => {
    void it('accepts an empty object', () => {
      const validated = validateOutboxEventInput(validEvent({ payload: {} }));
      assert.equal(validated.payloadJson, '{}');
    });

    void it('accepts a nested JSON object', () => {
      const payload = { membershipId: UUID_V7, nested: { ok: true, n: 1 } };
      const validated = validateOutboxEventInput(validEvent({ payload }));
      assert.deepEqual(JSON.parse(validated.payloadJson), payload);
    });

    void it('rejects a top-level array', () => {
      assertInvalid(validEvent({ payload: [] }), 'INVALID_PAYLOAD');
    });

    void it('rejects a top-level null', () => {
      assertInvalid(validEvent({ payload: null }), 'INVALID_PAYLOAD');
    });

    void it('rejects nested undefined', () => {
      assertInvalid(
        validEvent({ payload: { membershipId: undefined } }),
        'INVALID_PAYLOAD',
      );
    });

    void it('rejects bigint', () => {
      assertInvalid(validEvent({ payload: { n: 1n } }), 'INVALID_PAYLOAD');
    });

    void it('rejects a function', () => {
      assertInvalid(
        validEvent({ payload: { fn: () => undefined } }),
        'INVALID_PAYLOAD',
      );
    });

    void it('rejects a symbol', () => {
      assertInvalid(
        validEvent({ payload: { mark: Symbol('x') } }),
        'INVALID_PAYLOAD',
      );
    });

    void it('rejects a Date', () => {
      assertInvalid(
        validEvent({ payload: { when: new Date() } }),
        'INVALID_PAYLOAD',
      );
    });

    void it('rejects a circular object', () => {
      const payload: { self?: unknown } = {};
      payload.self = payload;
      assertInvalid(validEvent({ payload }), 'INVALID_PAYLOAD');
    });

    void it('never echoes payload contents on validation failure', () => {
      const secret = 'super-secret-email@example.com';
      try {
        validateOutboxEventInput(validEvent({ payload: [secret] }));
        assert.fail('expected validation to fail');
      } catch (error) {
        assert.ok(error instanceof OutboxEventValidationError);
        assert.equal(error.message.includes(secret), false);
        assert.equal(String(error).includes(secret), false);
        assert.equal(JSON.stringify(error).includes(secret), false);
      }
    });
  });

  void describe('payload size', () => {
    void it('accepts a comfortably small payload', () => {
      const validated = validateOutboxEventInput(
        validEvent({ payload: { membershipId: UUID_V7 } }),
      );
      assert.equal(
        new TextEncoder().encode(validated.payloadJson).length <=
          MAX_OUTBOX_PAYLOAD_BYTES,
        true,
      );
    });

    void it('accepts exactly 65,536 UTF-8 serialized bytes', () => {
      const payload = payloadWithUtf8Bytes(MAX_OUTBOX_PAYLOAD_BYTES, 'x');
      const validated = validateOutboxEventInput(validEvent({ payload }));
      assert.equal(
        new TextEncoder().encode(validated.payloadJson).length,
        MAX_OUTBOX_PAYLOAD_BYTES,
      );
    });

    void it('rejects 65,537 UTF-8 serialized bytes', () => {
      const payload = payloadWithUtf8Bytes(MAX_OUTBOX_PAYLOAD_BYTES + 1, 'x');
      assertInvalid(validEvent({ payload }), 'PAYLOAD_TOO_LARGE');
    });

    void it('enforces UTF-8 byte count, not JS string.length', () => {
      const payload = payloadWithUtf8Bytes(MAX_OUTBOX_PAYLOAD_BYTES + 4, '😀');
      const serialized = JSON.stringify(payload);
      assert.equal(serialized.length < MAX_OUTBOX_PAYLOAD_BYTES, true);
      assert.equal(
        new TextEncoder().encode(serialized).length > MAX_OUTBOX_PAYLOAD_BYTES,
        true,
      );
      assertInvalid(validEvent({ payload }), 'PAYLOAD_TOO_LARGE');
    });
  });
});
