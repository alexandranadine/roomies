import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvalidHomeLocalDateError } from './errors.js';
import { parseHomeLocalDate } from './home-local-date.js';

void describe('parseHomeLocalDate', () => {
  void it('accepts real calendar days and returns the same YYYY-MM-DD string', () => {
    assert.equal(parseHomeLocalDate('2026-09-15'), '2026-09-15');
    assert.equal(parseHomeLocalDate('2027-02-28'), '2027-02-28');
    assert.equal(parseHomeLocalDate('2024-02-29'), '2024-02-29');
  });

  void it('rejects impossible calendar dates', () => {
    assert.throws(
      () => parseHomeLocalDate('2026-02-30'),
      InvalidHomeLocalDateError,
    );
    assert.throws(
      () => parseHomeLocalDate('2026-13-01'),
      InvalidHomeLocalDateError,
    );
    assert.throws(
      () => parseHomeLocalDate('2025-02-29'),
      InvalidHomeLocalDateError,
    );
    assert.throws(
      () => parseHomeLocalDate('2026-00-10'),
      InvalidHomeLocalDateError,
    );
    assert.throws(
      () => parseHomeLocalDate('2026-04-31'),
      InvalidHomeLocalDateError,
    );
  });

  void it('rejects non-calendar and timestamp forms without using JS Date', () => {
    assert.throws(
      () => parseHomeLocalDate('09/15/2026'),
      InvalidHomeLocalDateError,
    );
    assert.throws(
      () => parseHomeLocalDate('2026-9-5'),
      InvalidHomeLocalDateError,
    );
    assert.throws(
      () => parseHomeLocalDate('2026-09-15T00:00:00Z'),
      InvalidHomeLocalDateError,
    );
    assert.throws(
      () => parseHomeLocalDate('2026-09-15T00:00:00.000Z'),
      InvalidHomeLocalDateError,
    );
    assert.throws(
      () => parseHomeLocalDate(' 2026-09-15 '),
      InvalidHomeLocalDateError,
    );
    assert.throws(() => parseHomeLocalDate(''), InvalidHomeLocalDateError);
  });
});
