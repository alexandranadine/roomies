export const TASK_ACTION = {
  create: 'task.create',
  list: 'task.list',
  complete: 'task.complete',
} as const;

export type TaskAction = (typeof TASK_ACTION)[keyof typeof TASK_ACTION];

export const TASK_DEFINITION_ACTION = {
  create: 'task_definition.create',
  list: 'task_definition.list',
  deactivate: 'task_definition.deactivate',
} as const;

export type TaskDefinitionAction =
  (typeof TASK_DEFINITION_ACTION)[keyof typeof TASK_DEFINITION_ACTION];
