export type OutboxEventValidationReason =
  | 'INVALID_EVENT_ID'
  | 'INVALID_EVENT_TYPE'
  | 'INVALID_OCCURRED_AT'
  | 'INVALID_HOME_ID'
  | 'INVALID_PAYLOAD'
  | 'PAYLOAD_TOO_LARGE';

/**
 * Caller/programmer outbox input is invalid. Messages never include payload
 * contents, raw JSON, IDs, or secrets. This is not a user-facing HTTP error.
 */
export class OutboxEventValidationError extends Error {
  override readonly name = 'OutboxEventValidationError';
  readonly reason: OutboxEventValidationReason;

  constructor(reason: OutboxEventValidationReason) {
    super('Outbox event input is invalid');
    this.reason = reason;
  }
}
