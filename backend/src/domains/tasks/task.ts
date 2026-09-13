export const TASK_SOURCES = ['MANUAL', 'RECURRING'] as const;
export const TASK_STATUSES = ['OPEN', 'COMPLETED'] as const;

export type TaskSource = (typeof TASK_SOURCES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Home-scoped TaskInstance snapshot. Recurring rows render from these
 * persisted fields, never from a live TaskDefinition join.
 */
export type TaskInstance = Readonly<{
  id: string;
  homeId: string;
  source: TaskSource;
  status: TaskStatus;
  title: string;
  scheduledFor: string | null;
  assignedMembershipId: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export function isTaskSource(value: unknown): value is TaskSource {
  return value === 'MANUAL' || value === 'RECURRING';
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return value === 'OPEN' || value === 'COMPLETED';
}
