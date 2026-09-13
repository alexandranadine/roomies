export class InvalidTaskTitleError extends Error {
  override readonly name = 'InvalidTaskTitleError';

  constructor() {
    super('Invalid Task title');
  }
}

export class InvalidHomeLocalDateError extends Error {
  override readonly name = 'InvalidHomeLocalDateError';

  constructor() {
    super('Invalid Home-local date');
  }
}

export class TaskPersistenceError extends Error {
  override readonly name = 'TaskPersistenceError';

  constructor() {
    super('Task persistence failure');
  }
}

/**
 * Visible state conflict: completion is OPEN → COMPLETED exactly once.
 * A second complete does not update completedAt or emit another transition.
 */
export class TaskAlreadyCompletedError extends Error {
  override readonly name = 'TaskAlreadyCompletedError';
  readonly code = 'TASK_ALREADY_COMPLETED';

  constructor() {
    super('Task already completed');
  }
}
