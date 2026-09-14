import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Temporal } from '@js-temporal/polyfill';
import { InvalidHomeLocalDateError } from './errors.js';
import {
  homeLocalDateFromInstant,
  parseHomeLocalDate,
} from './home-local-date.js';

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

void describe('homeLocalDateFromInstant', () => {
  void it('uses the Home timezone rather than UTC midnight', () => {
    const instant = Temporal.Instant.from('2026-09-14T00:00:00Z');
    assert.equal(homeLocalDateFromInstant(instant, 'UTC'), '2026-09-14');
    assert.equal(
      homeLocalDateFromInstant(instant, 'America/Los_Angeles'),
      '2026-09-13',
    );
    assert.equal(
      homeLocalDateFromInstant(
        Temporal.Instant.from('2026-09-14T07:00:00Z'),
        'America/Los_Angeles',
      ),
      '2026-09-14',
    );
  });

  void it('crosses the America/Los_Angeles spring-forward DST date correctly', () => {
    assert.equal(
      homeLocalDateFromInstant(
        Temporal.Instant.from('2026-03-08T07:30:00Z'),
        'America/Los_Angeles',
      ),
      '2026-03-07',
    );
    assert.equal(
      homeLocalDateFromInstant(
        Temporal.Instant.from('2026-03-08T10:00:00Z'),
        'America/Los_Angeles',
      ),
      '2026-03-08',
    );
  });

  void it('matches the frozen Pacific/Apia instant-to-date conversion', () => {
    const instant = Temporal.Instant.from('2011-12-30T10:00:00Z');
    assert.equal(
      homeLocalDateFromInstant(instant, 'Pacific/Apia'),
      '2011-12-31',
    );
    assert.equal(
      instant.toZonedDateTimeISO('Pacific/Apia').toPlainDate().toString(),
      '2011-12-31',
    );
    assert.equal(parseHomeLocalDate('2011-12-30'), '2011-12-30');
  });
});
