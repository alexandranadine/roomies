import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvalidPathInputError } from '../authz/errors.js';
import { parsePathUuid } from './path-id.js';

const UUID_V4 = '11111111-1111-4111-8111-111111111111';
const UUID_V7 = '018f1e2c-7e3a-7000-8000-1234567890ab';

void describe('parsePathUuid', () => {
  void it('accepts UUIDv4 auth-provisioned IDs and UUIDv7 domain IDs', () => {
    assert.equal(parsePathUuid(UUID_V4), UUID_V4);
    assert.equal(parsePathUuid(UUID_V7), UUID_V7);
    assert.equal(parsePathUuid(UUID_V4.toUpperCase()), UUID_V4.toUpperCase());
  });

  void it('rejects malformed path values', () => {
    for (const value of [
      'not-a-uuid',
      '123',
      '',
      '../../etc',
      '11111111-1111-4111-8111-11111111111',
      12,
      undefined,
      null,
    ]) {
      assert.throws(() => parsePathUuid(value), InvalidPathInputError);
    }
  });
});
