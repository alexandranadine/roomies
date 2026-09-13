import { InvalidHomeLocalDateError } from './errors.js';

/**
 * Home-local calendar DATE as YYYY-MM-DD. Not an instant. Do not construct
 * a JS Date or convert through a timezone.
 */
export const HOME_LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isGregorianLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isGregorianLeapYear(year)) {
    return 29;
  }
  return DAYS_IN_MONTH[month - 1] ?? 0;
}

/**
 * Accepts only a real Gregorian calendar day in exact YYYY-MM-DD form.
 * Returns the same string unchanged for persistence as DATE.
 */
export function parseHomeLocalDate(raw: string): string {
  const match = HOME_LOCAL_DATE_PATTERN.exec(raw);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new InvalidHomeLocalDateError();
  }
  if (match[3] === undefined) {
    throw new InvalidHomeLocalDateError();
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    throw new InvalidHomeLocalDateError();
  }

  return raw;
}
