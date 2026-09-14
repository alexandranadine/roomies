/**
 * Stable Notification persistence failure. Messages never include source
 * content, display text, names, Home IDs, or Membership IDs.
 */
export class NotificationPersistenceError extends Error {
  override readonly name = 'NotificationPersistenceError';

  constructor() {
    super('Notification persistence failure');
  }
}

export class InvalidNotificationRequestError extends Error {
  override readonly name = 'InvalidNotificationRequestError';
  readonly code = 'INVALID_REQUEST';

  constructor() {
    super('Invalid request');
  }
}
