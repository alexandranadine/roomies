import { describe, expect, it } from 'vitest';
import {
  formatDayOfMonth,
  formatHomeLocalDate,
  formatRecurrence,
  formatTaskDueLabel,
  formatTaskStatus,
  taskDueKind,
} from './task-format.js';

describe('task format', () => {
  it('labels Open and Done without using color-only copy', () => {
    expect(formatTaskStatus('OPEN')).toBe('Open');
    expect(formatTaskStatus('COMPLETED')).toBe('Done');
  });

  it('formats calendar due dates without timezone shift', () => {
    expect(formatHomeLocalDate('2026-09-25')).toMatch(/Sep/);
    expect(formatHomeLocalDate('2026-09-25')).toMatch(/25/);
  });

  it('classifies overdue, today, and upcoming from home-local dates', () => {
    expect(taskDueKind('2026-09-20', '2026-09-24')).toBe('overdue');
    expect(taskDueKind('2026-09-24', '2026-09-24')).toBe('today');
    expect(taskDueKind('2026-09-28', '2026-09-24')).toBe('upcoming');
    expect(formatTaskDueLabel('2026-09-24', '2026-09-24')).toBe('Today');
    expect(formatTaskDueLabel('2026-09-25', '2026-09-24')).toBe('Tomorrow');
    expect(formatTaskDueLabel('2026-09-20', '2026-09-24')).toMatch(/Overdue/);
    expect(formatTaskDueLabel('2026-09-28', '2026-09-24')).toMatch(/Sep/);
  });

  it('uses plain recurrence language', () => {
    expect(formatRecurrence('DAILY', null, null)).toBe('Every day');
    expect(formatRecurrence('WEEKLY', 2, null)).toBe('Every Tuesday');
    expect(formatRecurrence('WEEKLY', 1, null)).toBe('Every Monday');
    expect(formatRecurrence('MONTHLY', null, 1)).toBe(
      'Every month on the 1st',
    );
    expect(formatRecurrence('MONTHLY', null, 15)).toBe(
      'Every month on the 15th',
    );
    expect(formatDayOfMonth(22)).toBe('22nd');
    expect(formatDayOfMonth(23)).toBe('23rd');
    expect(formatDayOfMonth(11)).toBe('11th');
  });
});
