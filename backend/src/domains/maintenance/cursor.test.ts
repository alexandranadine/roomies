import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertMaintenanceListLimit,
  bindMaintenanceListCursor,
  decodeMaintenanceListCursor,
  encodeMaintenanceListCursor,
  MAINTENANCE_LIST_DEFAULT_LIMIT,
  MAINTENANCE_LIST_MAX_LIMIT,
  MAINTENANCE_LIST_MIN_LIMIT,
  MAINTENANCE_LIST_QUERY_FINGERPRINT,
  type MaintenanceListCursorPayload,
} from './cursor.js';
import { InvalidMaintenanceRequestError } from './errors.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTOR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENTRY = '018f1e2c-7e3a-7000-8000-1234567890ab';
const UPDATED = '2026-09-13T12:00:00.000Z';

function payload(
  overrides: Partial<MaintenanceListCursorPayload> = {},
): MaintenanceListCursorPayload {
  return {
    v: 1,
    statusRank: 0,
    updatedAt: UPDATED,
    id: ENTRY,
    homeId: HOME,
    actorMembershipId: ACTOR,
    statusFilter: null,
    queryFingerprint: MAINTENANCE_LIST_QUERY_FINGERPRINT,
    ...overrides,
  };
}

void describe('Maintenance list cursor', () => {
  void it('encodes only the frozen visible keyset and binding fields', () => {
    const encoded = encodeMaintenanceListCursor(payload());
    const decoded = decodeMaintenanceListCursor(encoded);
    assert.deepEqual(decoded, payload());
    assert.deepEqual(Object.keys(decoded), [
      'v',
      'statusRank',
      'updatedAt',
      'id',
      'homeId',
      'actorMembershipId',
      'statusFilter',
      'queryFingerprint',
    ]);
    assert.match(encoded, /^[A-Za-z0-9_-]+$/);
    assert.equal(encoded.includes('='), false);
    assert.equal(MAINTENANCE_LIST_DEFAULT_LIMIT, 25);
    assert.equal(MAINTENANCE_LIST_MIN_LIMIT, 1);
    assert.equal(MAINTENANCE_LIST_MAX_LIMIT, 100);
  });

  void it('binds a matching request context', () => {
    const encoded = encodeMaintenanceListCursor(
      payload({ statusFilter: 'OPEN' }),
    );
    assert.deepEqual(
      bindMaintenanceListCursor(encoded, {
        homeId: HOME,
        actorMembershipId: ACTOR,
        statusFilter: 'OPEN',
        queryFingerprint: MAINTENANCE_LIST_QUERY_FINGERPRINT,
      }),
      payload({ statusFilter: 'OPEN' }),
    );
  });

  void it('rejects malformed encodings', () => {
    assert.throws(
      () => decodeMaintenanceListCursor('%%%'),
      InvalidMaintenanceRequestError,
    );
    assert.throws(
      () => decodeMaintenanceListCursor('not-json'),
      InvalidMaintenanceRequestError,
    );
    assert.throws(
      () =>
        decodeMaintenanceListCursor(
          Buffer.from('[]', 'utf8').toString('base64url'),
        ),
      InvalidMaintenanceRequestError,
    );
    const extra = JSON.parse(
      Buffer.from(encodeMaintenanceListCursor(payload()), 'base64url').toString(
        'utf8',
      ),
    ) as Record<string, unknown>;
    extra.offset = 10;
    assert.throws(
      () =>
        decodeMaintenanceListCursor(
          Buffer.from(JSON.stringify(extra), 'utf8').toString('base64url'),
        ),
      InvalidMaintenanceRequestError,
    );
  });

  void it('rejects Home, actor, status, and fingerprint mismatches', () => {
    const encoded = encodeMaintenanceListCursor(payload());
    const binding: {
      homeId: string;
      actorMembershipId: string;
      statusFilter: null;
      queryFingerprint: string;
    } = {
      homeId: HOME,
      actorMembershipId: ACTOR,
      statusFilter: null,
      queryFingerprint: MAINTENANCE_LIST_QUERY_FINGERPRINT,
    };
    assert.throws(
      () =>
        bindMaintenanceListCursor(encoded, {
          ...binding,
          homeId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        }),
      InvalidMaintenanceRequestError,
    );
    assert.throws(
      () =>
        bindMaintenanceListCursor(encoded, {
          ...binding,
          actorMembershipId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        }),
      InvalidMaintenanceRequestError,
    );
    assert.throws(
      () =>
        bindMaintenanceListCursor(encoded, {
          ...binding,
          statusFilter: 'OPEN',
        }),
      InvalidMaintenanceRequestError,
    );
    assert.throws(
      () =>
        bindMaintenanceListCursor(encoded, {
          ...binding,
          queryFingerprint: 'a'.repeat(64),
        }),
      InvalidMaintenanceRequestError,
    );
  });

  void it('rejects invalid page limits', () => {
    assert.equal(assertMaintenanceListLimit(25), 25);
    assert.throws(
      () => assertMaintenanceListLimit(0),
      InvalidMaintenanceRequestError,
    );
    assert.throws(
      () => assertMaintenanceListLimit(101),
      InvalidMaintenanceRequestError,
    );
    assert.throws(
      () => assertMaintenanceListLimit(1.5),
      InvalidMaintenanceRequestError,
    );
  });
});
