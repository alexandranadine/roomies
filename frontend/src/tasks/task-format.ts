import type { Task, TaskDefinition, TaskRecurrenceFrequency } from './tasks-api.js';

const HOME_LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const WEEKDAY_LABELS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

export type TaskDueKind = 'overdue' | 'today' | 'upcoming';

export function formatTaskStatus(status: Task['status']): string {
  return status === 'COMPLETED' ? 'Done' : 'Open';
}

export function formatHomeLocalDate(value: string): string {
  const match = HOME_LOCAL_DATE_PATTERN.exec(value);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return value;
  }
  if (match[3] === undefined) {
    return value;
  }

  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  if (Number.isNaN(date.valueOf())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function homeLocalToday(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (year === undefined || month === undefined || day === undefined) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }
  return `${year}-${month}-${day}`;
}

export function isoWeekdayInTimeZone(timeZone: string): number {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
  }).format(new Date());
  switch (weekday) {
    case 'Mon':
      return 1;
    case 'Tue':
      return 2;
    case 'Wed':
      return 3;
    case 'Thu':
      return 4;
    case 'Fri':
      return 5;
    case 'Sat':
      return 6;
    default:
      return 7;
  }
}

export function dayOfMonthInTimeZone(timeZone: string): number {
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone,
    day: 'numeric',
  }).format(new Date());
  const parsed = Number(day);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 31) {
    return 1;
  }
  return parsed;
}

export function taskDueKind(
  scheduledFor: string,
  today: string,
): TaskDueKind {
  if (scheduledFor < today) {
    return 'overdue';
  }
  if (scheduledFor === today) {
    return 'today';
  }
  return 'upcoming';
}

export function formatTaskDueLabel(
  scheduledFor: string,
  today: string,
): string {
  const kind = taskDueKind(scheduledFor, today);
  const dateLabel = formatHomeLocalDate(scheduledFor);
  switch (kind) {
    case 'overdue':
      return `Overdue · ${dateLabel}`;
    case 'today':
      return 'Due today';
    case 'upcoming':
      return `Due ${dateLabel}`;
  }
}

export function weekdayLabel(weekday: number): string {
  return WEEKDAY_LABELS[weekday - 1] ?? `Day ${weekday}`;
}

export function formatRecurrence(
  frequency: TaskRecurrenceFrequency,
  weekday: number | null,
  dayOfMonth: number | null,
): string {
  switch (frequency) {
    case 'DAILY':
      return 'Every day';
    case 'WEEKLY':
      return weekday === null
        ? 'Every week'
        : `Every week on ${weekdayLabel(weekday)}`;
    case 'MONTHLY':
      return dayOfMonth === null
        ? 'Every month'
        : `Every month on day ${dayOfMonth}`;
  }
}

export function formatDefinitionNext(definition: TaskDefinition): string | null {
  if (definition.deactivatedAt !== null) {
    return null;
  }
  if (definition.nextOccurrenceDate === null) {
    return null;
  }
  return `Next ${formatHomeLocalDate(definition.nextOccurrenceDate)}`;
}

export function isActiveTaskDefinition(definition: TaskDefinition): boolean {
  return definition.deactivatedAt === null;
}
