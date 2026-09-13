import { Temporal } from '@js-temporal/polyfill';
import { parseHomeLocalDate, type DateString } from './home-local-date.js';

export const TASK_RECURRENCE_FREQUENCIES = [
  'DAILY',
  'WEEKLY',
  'MONTHLY',
] as const;

export type TaskRecurrenceFrequency =
  (typeof TASK_RECURRENCE_FREQUENCIES)[number];

export type RecurrenceCursor = Readonly<{
  occurrenceDate: DateString;
  occurrenceAt: Temporal.Instant;
}>;

type RecurrenceConfiguration = Readonly<{
  frequency: TaskRecurrenceFrequency;
  weekday: number | null;
  dayOfMonth: number | null;
  homeTimeZone: string;
}>;

export type ComputeInitialRecurrenceCursorInput = RecurrenceConfiguration &
  Readonly<{
    createdAt: Temporal.Instant;
  }>;

export type ComputeNextRecurrenceCursorInput = RecurrenceConfiguration &
  Readonly<{
    previousOccurrenceDate: DateString;
  }>;

function assertConfiguration(input: RecurrenceConfiguration): void {
  switch (input.frequency) {
    case 'DAILY':
      if (input.weekday !== null || input.dayOfMonth !== null) {
        throw new RangeError('Invalid DAILY recurrence configuration');
      }
      return;
    case 'WEEKLY':
      if (
        !Number.isInteger(input.weekday) ||
        input.weekday === null ||
        input.weekday < 1 ||
        input.weekday > 7 ||
        input.dayOfMonth !== null
      ) {
        throw new RangeError('Invalid WEEKLY recurrence configuration');
      }
      return;
    case 'MONTHLY':
      if (
        input.weekday !== null ||
        !Number.isInteger(input.dayOfMonth) ||
        input.dayOfMonth === null ||
        input.dayOfMonth < 1 ||
        input.dayOfMonth > 31
      ) {
        throw new RangeError('Invalid MONTHLY recurrence configuration');
      }
  }
}

function toDateString(date: Temporal.PlainDate): DateString {
  return parseHomeLocalDate(date.toString());
}

/**
 * Resolves logical local midnight with Temporal "compatible" disambiguation:
 * ambiguous times choose the earlier instant and nonexistent times shift
 * forward by the timezone gap.
 */
export function resolveLocalMidnight(
  occurrenceDate: DateString,
  homeTimeZone: string,
): Temporal.Instant {
  return Temporal.PlainDate.from(occurrenceDate)
    .toPlainDateTime(Temporal.PlainTime.from('00:00:00'))
    .toZonedDateTime(homeTimeZone, { disambiguation: 'compatible' })
    .toInstant();
}

function monthlyDate(
  year: number,
  month: number,
  configuredDayOfMonth: number,
): Temporal.PlainDate {
  const first = Temporal.PlainDate.from({ year, month, day: 1 });
  return first.with({
    day: Math.min(configuredDayOfMonth, first.daysInMonth),
  });
}

function nextLogicalDate(
  input: RecurrenceConfiguration,
  previous: Temporal.PlainDate,
): Temporal.PlainDate {
  switch (input.frequency) {
    case 'DAILY':
      return previous.add({ days: 1 });
    case 'WEEKLY': {
      const weekday = input.weekday;
      if (weekday === null) {
        throw new RangeError('Invalid WEEKLY recurrence configuration');
      }
      const daysAhead = ((weekday - previous.dayOfWeek + 6) % 7) + 1;
      return previous.add({ days: daysAhead });
    }
    case 'MONTHLY': {
      const dayOfMonth = input.dayOfMonth;
      if (dayOfMonth === null) {
        throw new RangeError('Invalid MONTHLY recurrence configuration');
      }
      const nextMonth = previous.with({ day: 1 }).add({ months: 1 });
      return monthlyDate(nextMonth.year, nextMonth.month, dayOfMonth);
    }
  }
}

function initialLogicalDate(
  input: RecurrenceConfiguration,
  localCreatedDate: Temporal.PlainDate,
): Temporal.PlainDate {
  switch (input.frequency) {
    case 'DAILY':
      return localCreatedDate;
    case 'WEEKLY': {
      const weekday = input.weekday;
      if (weekday === null) {
        throw new RangeError('Invalid WEEKLY recurrence configuration');
      }
      const daysAhead = (weekday - localCreatedDate.dayOfWeek + 7) % 7;
      return localCreatedDate.add({ days: daysAhead });
    }
    case 'MONTHLY': {
      const dayOfMonth = input.dayOfMonth;
      if (dayOfMonth === null) {
        throw new RangeError('Invalid MONTHLY recurrence configuration');
      }
      const thisMonth = monthlyDate(
        localCreatedDate.year,
        localCreatedDate.month,
        dayOfMonth,
      );
      if (Temporal.PlainDate.compare(thisMonth, localCreatedDate) >= 0) {
        return thisMonth;
      }
      const nextMonth = localCreatedDate.with({ day: 1 }).add({ months: 1 });
      return monthlyDate(nextMonth.year, nextMonth.month, dayOfMonth);
    }
  }
}

function cursorFor(
  occurrenceDate: Temporal.PlainDate,
  homeTimeZone: string,
): RecurrenceCursor {
  const date = toDateString(occurrenceDate);
  return Object.freeze({
    occurrenceDate: date,
    occurrenceAt: resolveLocalMidnight(date, homeTimeZone),
  });
}

/**
 * Finds the first qualifying logical Home-local recurrence date whose
 * resolved instant is strictly later than createdAt.
 */
export function computeInitialRecurrenceCursor(
  input: ComputeInitialRecurrenceCursorInput,
): RecurrenceCursor {
  assertConfiguration(input);
  const localCreatedDate = input.createdAt
    .toZonedDateTimeISO(input.homeTimeZone)
    .toPlainDate();
  let candidate = initialLogicalDate(input, localCreatedDate);

  for (;;) {
    const cursor = cursorFor(candidate, input.homeTimeZone);
    if (Temporal.Instant.compare(cursor.occurrenceAt, input.createdAt) > 0) {
      return cursor;
    }
    candidate = nextLogicalDate(input, candidate);
  }
}

/**
 * Advances from the persisted logical date. It never derives a date from the
 * previous instant, and monthly clamping always reuses the configured day.
 */
export function computeNextRecurrenceCursor(
  input: ComputeNextRecurrenceCursorInput,
): RecurrenceCursor {
  assertConfiguration(input);
  const previous = Temporal.PlainDate.from(input.previousOccurrenceDate);
  return cursorFor(nextLogicalDate(input, previous), input.homeTimeZone);
}
