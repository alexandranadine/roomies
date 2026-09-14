export class ActivityPersistenceError extends Error {
  override readonly name = 'ActivityPersistenceError';

  constructor() {
    super('Activity persistence failure');
  }
}

/**
 * SOURCE_AUTHORIZED insertion requires at least one Membership recipient
 * after deterministic deduplication. Rejected before any write.
 */
export class EmptyActivityRecipientSetError extends Error {
  override readonly name = 'EmptyActivityRecipientSetError';

  constructor() {
    super('SOURCE_AUTHORIZED Activity requires at least one recipient');
  }
}

export class InvalidActivityRequestError extends Error {
  override readonly name = 'InvalidActivityRequestError';
  readonly code = 'INVALID_REQUEST';

  constructor() {
    super('Invalid request');
  }
}
