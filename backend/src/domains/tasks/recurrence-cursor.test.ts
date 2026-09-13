import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Temporal } from '@js-temporal/polyfill';
import { parseHomeLocalDate } from './home-local-date.js';
import {
  computeInitialRecurrenceCursor,
  computeNextRecurrenceCursor,
  resolveLocalMidnight,
} from './recurrence-cursor.js';

const instant = (value: string) => Temporal.Instant.from(value);
const date = parseHomeLocalDate;

void describe('recurrence cursor', () => {
  void it('computes the initial DAILY cursor in the Home timezone', () => {
    const utc = computeInitialRecurrenceCursor({
      frequency: 'DAILY',
      weekday: null,
      dayOfMonth: null,
      homeTimeZone: 'UTC',
      createdAt: instant('2026-09-12T12:00:00Z'),
    });
    assert.equal(utc.occurrenceDate, '2026-09-13');
    assert.equal(utc.occurrenceAt.toString(), '2026-09-13T00:00:00Z');

    const losAngeles = computeInitialRecurrenceCursor({
      frequency: 'DAILY',
      weekday: null,
      dayOfMonth: null,
      homeTimeZone: 'America/Los_Angeles',
      createdAt: instant('2026-09-12T06:00:00Z'),
    });
    assert.equal(losAngeles.occurrenceDate, '2026-09-12');
    assert.equal(losAngeles.occurrenceAt.toString(), '2026-09-12T07:00:00Z');
  });

  void it('computes the initial WEEKLY cursor using ISO weekdays', () => {
    const cursor = computeInitialRecurrenceCursor({
      frequency: 'WEEKLY',
      weekday: 1,
      dayOfMonth: null,
      homeTimeZone: 'UTC',
      createdAt: instant('2026-09-15T12:00:00Z'),
    });
    assert.equal(cursor.occurrenceDate, '2026-09-21');
    assert.equal(cursor.occurrenceAt.toString(), '2026-09-21T00:00:00Z');
  });

  void it('computes the initial MONTHLY cursor with independent clamping', () => {
    const cursor = computeInitialRecurrenceCursor({
      frequency: 'MONTHLY',
      weekday: null,
      dayOfMonth: 31,
      homeTimeZone: 'Asia/Kathmandu',
      createdAt: instant('2026-04-15T00:00:00Z'),
    });
    assert.equal(cursor.occurrenceDate, '2026-04-30');
    assert.equal(cursor.occurrenceAt.toString(), '2026-04-29T18:15:00Z');
  });

  void it('requires occurrenceAt to be strictly greater than createdAt', () => {
    const cursor = computeInitialRecurrenceCursor({
      frequency: 'DAILY',
      weekday: null,
      dayOfMonth: null,
      homeTimeZone: 'UTC',
      createdAt: instant('2026-09-13T00:00:00Z'),
    });
    assert.equal(cursor.occurrenceDate, '2026-09-14');
  });

  void it('advances DAILY by a local calendar day, including negative offsets', () => {
    const cursor = computeNextRecurrenceCursor({
      frequency: 'DAILY',
      weekday: null,
      dayOfMonth: null,
      homeTimeZone: 'Pacific/Honolulu',
      previousOccurrenceDate: date('2026-09-12'),
    });
    assert.equal(cursor.occurrenceDate, '2026-09-13');
    assert.equal(cursor.occurrenceAt.toString(), '2026-09-13T10:00:00Z');
  });

  void it('advances WEEKLY to the next configured ISO weekday', () => {
    const cursor = computeNextRecurrenceCursor({
      frequency: 'WEEKLY',
      weekday: 7,
      dayOfMonth: null,
      homeTimeZone: 'UTC',
      previousOccurrenceDate: date('2026-09-13'),
    });
    assert.equal(cursor.occurrenceDate, '2026-09-20');
  });

  void it('recovers the configured monthly day after a clamp', () => {
    const february = computeNextRecurrenceCursor({
      frequency: 'MONTHLY',
      weekday: null,
      dayOfMonth: 31,
      homeTimeZone: 'UTC',
      previousOccurrenceDate: date('2027-01-31'),
    });
    assert.equal(february.occurrenceDate, '2027-02-28');

    const march = computeNextRecurrenceCursor({
      frequency: 'MONTHLY',
      weekday: null,
      dayOfMonth: 31,
      homeTimeZone: 'UTC',
      previousOccurrenceDate: february.occurrenceDate,
    });
    assert.equal(march.occurrenceDate, '2027-03-31');
  });

  void it('clamps February according to leap-year rules', () => {
    const leap = computeNextRecurrenceCursor({
      frequency: 'MONTHLY',
      weekday: null,
      dayOfMonth: 29,
      homeTimeZone: 'UTC',
      previousOccurrenceDate: date('2024-01-29'),
    });
    assert.equal(leap.occurrenceDate, '2024-02-29');

    const common = computeNextRecurrenceCursor({
      frequency: 'MONTHLY',
      weekday: null,
      dayOfMonth: 29,
      homeTimeZone: 'UTC',
      previousOccurrenceDate: date('2025-01-29'),
    });
    assert.equal(common.occurrenceDate, '2025-02-28');
  });

  void it('preserves Pacific/Apia skipped 2011-12-30 as the logical date', () => {
    const cursor = computeNextRecurrenceCursor({
      frequency: 'DAILY',
      weekday: null,
      dayOfMonth: null,
      homeTimeZone: 'Pacific/Apia',
      previousOccurrenceDate: date('2011-12-29'),
    });
    assert.equal(cursor.occurrenceDate, '2011-12-30');
    assert.equal(cursor.occurrenceAt.toString(), '2011-12-30T10:00:00Z');
    assert.equal(
      cursor.occurrenceAt
        .toZonedDateTimeISO('Pacific/Apia')
        .toPlainDate()
        .toString(),
      '2011-12-31',
    );
  });

  void it('uses the earlier instant for an ambiguous local midnight', () => {
    const resolved = resolveLocalMidnight(date('2000-10-29'), 'America/Havana');
    assert.equal(resolved.toString(), '2000-10-29T04:00:00Z');
  });

  void it('shifts forward by the gap for a nonexistent local midnight', () => {
    const resolved = resolveLocalMidnight(date('2000-04-02'), 'America/Havana');
    assert.equal(resolved.toString(), '2000-04-02T05:00:00Z');
    assert.equal(
      resolved.toZonedDateTimeISO('America/Havana').toPlainTime().toString(),
      '01:00:00',
    );
  });

  void it('re-resolves a persisted logical date when the Home timezone changes', () => {
    const logicalDate = date('2026-09-20');
    const oldInstant = resolveLocalMidnight(logicalDate, 'America/Los_Angeles');
    const newInstant = resolveLocalMidnight(logicalDate, 'Asia/Kathmandu');

    assert.equal(logicalDate, '2026-09-20');
    assert.equal(oldInstant.toString(), '2026-09-20T07:00:00Z');
    assert.equal(newInstant.toString(), '2026-09-19T18:15:00Z');
  });
});
