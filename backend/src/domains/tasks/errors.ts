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

export class InvalidRecurrenceConfigurationError extends Error {
  override readonly name = 'InvalidRecurrenceConfigurationError';

  constructor() {
    super('Invalid recurrence configuration');
  }
}

/**
 * Visible state conflict: deactivation happens exactly once.
 * A second deactivate does not rewrite deactivatedAt or the cleared cursor.
 */
export class TaskDefinitionAlreadyDeactivatedError extends Error {
  override readonly name = 'TaskDefinitionAlreadyDeactivatedError';
  readonly code = 'TASK_DEFINITION_ALREADY_DEACTIVATED';

  constructor() {
    super('Task definition already deactivated');
  }
}

/**
 * Canonical Task Activity source could not be read safely.
 * Messages never include title, assignee, Home, or Membership IDs.
 */
export class TaskActivitySourceIntegrityError extends Error {
  override readonly name = 'TaskActivitySourceIntegrityError';

  constructor() {
    super('Task activity source integrity failure');
  }
}

/**
 * Canonical Task Notification source could not be read safely.
 * Messages never include title, assignee, Home, or Membership IDs.
 */
export class TaskNotificationSourceIntegrityError extends Error {
  override readonly name = 'TaskNotificationSourceIntegrityError';

  constructor() {
    super('Task notification source integrity failure');
  }
}

/**
 * House Pulse Task summary could not be read safely.
 * Messages never include titles, assignees, Home, or Membership IDs.
 */
export class TaskPulseSummaryIntegrityError extends Error {
  override readonly name = 'TaskPulseSummaryIntegrityError';

  constructor() {
    super('Task pulse summary integrity failure');
  }
}
