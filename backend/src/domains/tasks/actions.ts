export const TASK_ACTION = {
  create: 'task.create',
  list: 'task.list',
} as const;

export type TaskAction = (typeof TASK_ACTION)[keyof typeof TASK_ACTION];
