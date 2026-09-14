import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertActivityListLimit,
  bindActivityListCursor,
  decodeActivityListCursor,
  encodeActivityListCursor,
  ACTIVITY_LIST_DEFAULT_LIMIT,
  ACTIVITY_LIST_MAX_LIMIT,
  ACTIVITY_LIST_MIN_LIMIT,
  ACTIVITY_LIST_QUERY_FINGERPRINT,
  type ActivityListCursorPayload,
} from './cursor.js';
import { InvalidActivityRequestError } from './errors.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACTOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_ACTOR = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ENTRY = '018f1e2c-7e3a-7000-8000-1234567890ab';
const OCCURRED = '2026-09-13T12:00:00.000Z';

function payload(
  overrides: Partial<ActivityListCursorPayload> = {},
): ActivityListCursorPayload {
  return {
    v: 1,
    occurredAt: OCCURRED,
    id: ENTRY,
    homeId: HOME,
    actorMembershipId: ACTOR,
    queryFingerprint: ACTIVITY_LIST_QUERY_FINGERPRINT,
    ...overrides,
  };
}

void describe('Activity list cursor', () => {
  void it('encodes only the frozen visible keyset and binding fields', () => {
    const encoded = encodeActivityListCursor(payload());
    const decoded = decodeActivityListCursor(encoded);
    assert.deepEqual(decoded, payload());
    assert.deepEqual(Object.keys(decoded), [
      'v',
      'occurredAt',
      'id',
      'homeId',
      'actorMembershipId',
      'queryFingerprint',
    ]);
    assert.match(encoded, /^[A-Za-z0-9_-]+$/);
    assert.equal(encoded.includes('='), false);
    assert.equal(ACTIVITY_LIST_DEFAULT_LIMIT, 25);
    assert.equal(ACTIVITY_LIST_MIN_LIMIT, 1);
    assert.equal(ACTIVITY_LIST_MAX_LIMIT, 100);
  });

  void it('binds a matching request context', () => {
    const encoded = encodeActivityListCursor(payload());
    assert.deepEqual(
      bindActivityListCursor(encoded, {
        homeId: HOME,
        actorMembershipId: ACTOR,
        queryFingerprint: ACTIVITY_LIST_QUERY_FINGERPRINT,
      }),
      payload(),
    );
  });

  void it('rejects malformed encodings', () => {
    assert.throws(
      () => decodeActivityListCursor('%%%'),
      InvalidActivityRequestError,
    );
    assert.throws(
      () => decodeActivityListCursor('not-json'),
      InvalidActivityRequestError,
    );
    assert.throws(
      () =>
        decodeActivityListCursor(
          Buffer.from('{"v":1}', 'utf8').toString('base64url'),
        ),
      InvalidActivityRequestError,
    );
  });

  void it('rejects forged Home, actor, and fingerprint bindings', () => {
    const encoded = encodeActivityListCursor(payload());
    assert.throws(
      () =>
        bindActivityListCursor(encoded, {
          homeId: OTHER_HOME,
          actorMembershipId: ACTOR,
          queryFingerprint: ACTIVITY_LIST_QUERY_FINGERPRINT,
        }),
      InvalidActivityRequestError,
    );
    assert.throws(
      () =>
        bindActivityListCursor(encoded, {
          homeId: HOME,
          actorMembershipId: OTHER_ACTOR,
          queryFingerprint: ACTIVITY_LIST_QUERY_FINGERPRINT,
        }),
      InvalidActivityRequestError,
    );
    assert.throws(
      () =>
        bindActivityListCursor(encoded, {
          homeId: HOME,
          actorMembershipId: ACTOR,
          queryFingerprint: '0'.repeat(64),
        }),
      InvalidActivityRequestError,
    );
  });

  void it('accepts only the bounded page-size range', () => {
    assert.equal(assertActivityListLimit(1), 1);
    assert.equal(assertActivityListLimit(25), 25);
    assert.equal(assertActivityListLimit(100), 100);
    assert.throws(
      () => assertActivityListLimit(0),
      InvalidActivityRequestError,
    );
    assert.throws(
      () => assertActivityListLimit(101),
      InvalidActivityRequestError,
    );
    assert.throws(
      () => assertActivityListLimit(1.5),
      InvalidActivityRequestError,
    );
  });
});
