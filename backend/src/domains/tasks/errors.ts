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
