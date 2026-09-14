import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertNotificationListLimit,
  bindNotificationListCursor,
  decodeNotificationListCursor,
  encodeNotificationListCursor,
  NOTIFICATION_LIST_DEFAULT_LIMIT,
  NOTIFICATION_LIST_MAX_LIMIT,
  NOTIFICATION_LIST_MIN_LIMIT,
  NOTIFICATION_LIST_QUERY_FINGERPRINT,
  type NotificationListCursorPayload,
} from './cursor.js';
import { InvalidNotificationRequestError } from './errors.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const ENTRY = '018f1e2c-7e3a-7000-8000-1234567890ab';
const OCCURRED = '2026-09-13T12:00:00.000Z';

function payload(
  overrides: Partial<NotificationListCursorPayload> = {},
): NotificationListCursorPayload {
  return {
    v: 1,
    occurredAt: OCCURRED,
    id: ENTRY,
    userId: USER,
    queryFingerprint: NOTIFICATION_LIST_QUERY_FINGERPRINT,
    ...overrides,
  };
}

void describe('Notification list cursor', () => {
  void it('encodes only the frozen visible keyset and binding fields', () => {
    const encoded = encodeNotificationListCursor(payload());
    const decoded = decodeNotificationListCursor(encoded);
    assert.deepEqual(decoded, payload());
    assert.deepEqual(Object.keys(decoded), [
      'v',
      'occurredAt',
      'id',
      'userId',
      'queryFingerprint',
    ]);
    assert.match(encoded, /^[A-Za-z0-9_-]+$/);
    assert.equal(encoded.includes('='), false);
    assert.equal(NOTIFICATION_LIST_DEFAULT_LIMIT, 25);
    assert.equal(NOTIFICATION_LIST_MIN_LIMIT, 1);
    assert.equal(NOTIFICATION_LIST_MAX_LIMIT, 100);
  });

  void it('binds a matching request context', () => {
    const encoded = encodeNotificationListCursor(payload());
    assert.deepEqual(
      bindNotificationListCursor(encoded, {
        userId: USER,
        queryFingerprint: NOTIFICATION_LIST_QUERY_FINGERPRINT,
      }),
      payload(),
    );
  });

  void it('rejects malformed encodings', () => {
    assert.throws(
      () => decodeNotificationListCursor('%%%'),
      InvalidNotificationRequestError,
    );
    assert.throws(
      () => decodeNotificationListCursor('not-json'),
      InvalidNotificationRequestError,
    );
    assert.throws(
      () =>
        decodeNotificationListCursor(
          Buffer.from('{"v":1}', 'utf8').toString('base64url'),
        ),
      InvalidNotificationRequestError,
    );
  });

  void it('rejects a cursor created by another User or query fingerprint', () => {
    const encoded = encodeNotificationListCursor(payload());
    assert.throws(
      () =>
        bindNotificationListCursor(encoded, {
          userId: OTHER_USER,
          queryFingerprint: NOTIFICATION_LIST_QUERY_FINGERPRINT,
        }),
      InvalidNotificationRequestError,
    );
    assert.throws(
      () =>
        bindNotificationListCursor(encoded, {
          userId: USER,
          queryFingerprint: '0'.repeat(64),
        }),
      InvalidNotificationRequestError,
    );
  });

  void it('accepts only the bounded page-size range', () => {
    assert.equal(assertNotificationListLimit(1), 1);
    assert.equal(assertNotificationListLimit(25), 25);
    assert.equal(assertNotificationListLimit(100), 100);
    assert.throws(
      () => assertNotificationListLimit(0),
      InvalidNotificationRequestError,
    );
    assert.throws(
      () => assertNotificationListLimit(101),
      InvalidNotificationRequestError,
    );
    assert.throws(
      () => assertNotificationListLimit(1.5),
      InvalidNotificationRequestError,
    );
  });
});
