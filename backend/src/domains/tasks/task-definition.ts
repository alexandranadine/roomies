import type { DateString } from './home-local-date.js';
import type { TaskRecurrenceFrequency } from './recurrence-cursor.js';

export type TaskDefinition = Readonly<{
  id: string;
  homeId: string;
  title: string;
  frequency: TaskRecurrenceFrequency;
  weekday: number | null;
  dayOfMonth: number | null;
  assignedMembershipId: string | null;
  creatorMembershipId: string;
  nextOccurrenceDate: DateString | null;
  nextOccurrenceAt: Date | null;
  deactivatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;
