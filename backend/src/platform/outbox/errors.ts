/**
 * Duplicate (handlerId, eventType) registration at composition/startup.
 * The message is content-free; identifiers are not payload data.
 */
export class DuplicateOutboxHandlerRegistrationError extends Error {
  override readonly name = 'DuplicateOutboxHandlerRegistrationError';
  readonly handlerId: string;
  readonly eventType: string;

  constructor(handlerId: string, eventType: string) {
    super('Duplicate outbox handler registration');
    this.handlerId = handlerId;
    this.eventType = eventType;
  }
}

/**
 * Handler registration is missing identity/types or uses an invalid versioned
 * type string. Messages never include payload contents.
 */
export class InvalidOutboxHandlerRegistrationError extends Error {
  override readonly name = 'InvalidOutboxHandlerRegistrationError';

  constructor() {
    super('Outbox handler registration is invalid');
  }
}
