import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canonicalizeIanaTimeZone,
  InvalidIanaTimeZoneError,
} from './iana-timezone.js';

void describe('canonicalizeIanaTimeZone', () => {
  void it('accepts canonical IANA identifiers including UTC', () => {
    assert.equal(
      canonicalizeIanaTimeZone('America/Los_Angeles'),
      'America/Los_Angeles',
    );
    assert.equal(
      canonicalizeIanaTimeZone('America/New_York'),
      'America/New_York',
    );
    assert.equal(canonicalizeIanaTimeZone('UTC'), 'UTC');
  });

  void it('trims surrounding whitespace of a valid identifier', () => {
    assert.equal(canonicalizeIanaTimeZone('  UTC  '), 'UTC');
  });

  void it('rejects empty, offset, and unknown values', () => {
    for (const value of ['', '   ', 'PST', '+05:30', 'Not/A/Zone', 'America']) {
      assert.throws(
        () => canonicalizeIanaTimeZone(value),
        InvalidIanaTimeZoneError,
      );
    }
  });
});
