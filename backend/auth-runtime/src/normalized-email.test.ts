import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  InvalidNormalizedEmailError,
  normalizeEmail,
} from './normalized-email.js';

void describe('normalizeEmail', () => {
  void it('trims and lowercases the complete address', () => {
    assert.equal(normalizeEmail(' TEST@Example.COM '), 'test@example.com');
  });

  void it('retains plus tags and dots', () => {
    assert.equal(
      normalizeEmail('First.Last+Roomies@Gmail.COM'),
      'first.last+roomies@gmail.com',
    );
  });

  void it('rejects invalid and unsupported syntax', () => {
    for (const value of [
      '',
      'not-an-email',
      '.leading@example.com',
      'trailing.@example.com',
      'double..dot@example.com',
      'person@localhost',
      'person@-example.com',
      'person@example.c',
      'üser@example.com',
      `${'a'.repeat(250)}@example.com`,
    ]) {
      assert.throws(
        () => normalizeEmail(value),
        InvalidNormalizedEmailError,
        value,
      );
    }
  });
});
