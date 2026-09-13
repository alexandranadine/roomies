import { InvalidRecurrenceConfigurationError } from './errors.js';
import {
  TASK_RECURRENCE_FREQUENCIES,
  type TaskRecurrenceFrequency,
} from './recurrence-cursor.js';

export type RecurrenceConfiguration = Readonly<{
  frequency: TaskRecurrenceFrequency;
  weekday: number | null;
  dayOfMonth: number | null;
}>;

export function isTaskRecurrenceFrequency(
  value: unknown,
): value is TaskRecurrenceFrequency {
  return (
    typeof value === 'string' &&
    (TASK_RECURRENCE_FREQUENCIES as readonly string[]).includes(value)
  );
}

/**
 * Validates recurrence fields against the TaskDefinition DB constraint.
 * ISO weekday: Monday=1 … Sunday=7. Rejects fractions and extra pairings.
 */
export function normalizeRecurrenceConfiguration(input: {
  frequency: TaskRecurrenceFrequency;
  weekday?: number | null;
  dayOfMonth?: number | null;
}): RecurrenceConfiguration {
  const weekday = input.weekday === undefined ? null : input.weekday;
  const dayOfMonth = input.dayOfMonth === undefined ? null : input.dayOfMonth;

  if (weekday !== null && !Number.isInteger(weekday)) {
    throw new InvalidRecurrenceConfigurationError();
  }
  if (dayOfMonth !== null && !Number.isInteger(dayOfMonth)) {
    throw new InvalidRecurrenceConfigurationError();
  }

  switch (input.frequency) {
    case 'DAILY':
      if (weekday !== null || dayOfMonth !== null) {
        throw new InvalidRecurrenceConfigurationError();
      }
      break;
    case 'WEEKLY':
      if (
        weekday === null ||
        weekday < 1 ||
        weekday > 7 ||
        dayOfMonth !== null
      ) {
        throw new InvalidRecurrenceConfigurationError();
      }
      break;
    case 'MONTHLY':
      if (
        weekday !== null ||
        dayOfMonth === null ||
        dayOfMonth < 1 ||
        dayOfMonth > 31
      ) {
        throw new InvalidRecurrenceConfigurationError();
      }
      break;
  }

  return Object.freeze({
    frequency: input.frequency,
    weekday,
    dayOfMonth,
  });
}
