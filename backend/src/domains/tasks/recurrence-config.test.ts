import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvalidRecurrenceConfigurationError } from './errors.js';
import { normalizeRecurrenceConfiguration } from './recurrence-config.js';

void describe('normalizeRecurrenceConfiguration', () => {
  void it('accepts valid DAILY, WEEKLY, and MONTHLY configurations', () => {
    assert.deepEqual(normalizeRecurrenceConfiguration({ frequency: 'DAILY' }), {
      frequency: 'DAILY',
      weekday: null,
      dayOfMonth: null,
    });
    assert.deepEqual(
      normalizeRecurrenceConfiguration({
        frequency: 'WEEKLY',
        weekday: 1,
      }),
      { frequency: 'WEEKLY', weekday: 1, dayOfMonth: null },
    );
    assert.deepEqual(
      normalizeRecurrenceConfiguration({
        frequency: 'WEEKLY',
        weekday: 7,
      }),
      { frequency: 'WEEKLY', weekday: 7, dayOfMonth: null },
    );
    assert.deepEqual(
      normalizeRecurrenceConfiguration({
        frequency: 'MONTHLY',
        dayOfMonth: 1,
      }),
      { frequency: 'MONTHLY', weekday: null, dayOfMonth: 1 },
    );
    assert.deepEqual(
      normalizeRecurrenceConfiguration({
        frequency: 'MONTHLY',
        dayOfMonth: 31,
      }),
      { frequency: 'MONTHLY', weekday: null, dayOfMonth: 31 },
    );
  });

  void it('rejects DAILY weekday or dayOfMonth', () => {
    assert.throws(
      () =>
        normalizeRecurrenceConfiguration({
          frequency: 'DAILY',
          weekday: 1,
        }),
      InvalidRecurrenceConfigurationError,
    );
    assert.throws(
      () =>
        normalizeRecurrenceConfiguration({
          frequency: 'DAILY',
          dayOfMonth: 15,
        }),
      InvalidRecurrenceConfigurationError,
    );
  });

  void it('requires WEEKLY weekday 1..7 and rejects dayOfMonth or fractions', () => {
    assert.throws(
      () => normalizeRecurrenceConfiguration({ frequency: 'WEEKLY' }),
      InvalidRecurrenceConfigurationError,
    );
    assert.throws(
      () =>
        normalizeRecurrenceConfiguration({
          frequency: 'WEEKLY',
          weekday: 1,
          dayOfMonth: 15,
        }),
      InvalidRecurrenceConfigurationError,
    );
    assert.throws(
      () =>
        normalizeRecurrenceConfiguration({
          frequency: 'WEEKLY',
          weekday: 0,
        }),
      InvalidRecurrenceConfigurationError,
    );
    assert.throws(
      () =>
        normalizeRecurrenceConfiguration({
          frequency: 'WEEKLY',
          weekday: 8,
        }),
      InvalidRecurrenceConfigurationError,
    );
    assert.throws(
      () =>
        normalizeRecurrenceConfiguration({
          frequency: 'WEEKLY',
          weekday: 1.5,
        }),
      InvalidRecurrenceConfigurationError,
    );
  });

  void it('requires MONTHLY dayOfMonth 1..31 and rejects weekday or fractions', () => {
    assert.throws(
      () => normalizeRecurrenceConfiguration({ frequency: 'MONTHLY' }),
      InvalidRecurrenceConfigurationError,
    );
    assert.throws(
      () =>
        normalizeRecurrenceConfiguration({
          frequency: 'MONTHLY',
          weekday: 1,
          dayOfMonth: 15,
        }),
      InvalidRecurrenceConfigurationError,
    );
    assert.throws(
      () =>
        normalizeRecurrenceConfiguration({
          frequency: 'MONTHLY',
          dayOfMonth: 0,
        }),
      InvalidRecurrenceConfigurationError,
    );
    assert.throws(
      () =>
        normalizeRecurrenceConfiguration({
          frequency: 'MONTHLY',
          dayOfMonth: 32,
        }),
      InvalidRecurrenceConfigurationError,
    );
    assert.throws(
      () =>
        normalizeRecurrenceConfiguration({
          frequency: 'MONTHLY',
          dayOfMonth: 15.2,
        }),
      InvalidRecurrenceConfigurationError,
    );
  });
});
