/**
 * Stable Notification projection integrity failure. The message is
 * deliberately free of event payload and protected source values.
 */
export class NotificationProjectionIntegrityError extends Error {
  override readonly name = 'NotificationProjectionIntegrityError';

  constructor() {
    super('Notification projection integrity failure');
  }
}
