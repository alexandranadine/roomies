import { describe, expect, it } from 'vitest';
import {
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
    expect(formatTaskDueLabel('2026-09-24', '2026-09-24')).toBe('Due today');
    expect(formatTaskDueLabel('2026-09-20', '2026-09-24')).toMatch(/Overdue/);
  });

  it('uses plain recurrence language', () => {
    expect(formatRecurrence('DAILY', null, null)).toBe('Every day');
    expect(formatRecurrence('WEEKLY', 1, null)).toBe('Every week on Monday');
    expect(formatRecurrence('MONTHLY', null, 15)).toBe(
      'Every month on day 15',
    );
  });
});
