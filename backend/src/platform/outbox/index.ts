export {
  DuplicateOutboxHandlerRegistrationError,
  InvalidOutboxHandlerRegistrationError,
} from './errors.js';
export {
  OUTBOX_HANDLER_ID_PATTERN,
  type OutboxEventHandler,
} from './handler.js';
export type { OutboxEvent } from './outbox-event.js';
export {
  createOutboxHandlerRegistry,
  type OutboxHandlerRegistry,
} from './registry.js';
export {
  DEFAULT_OUTBOX_BATCH_SIZE,
  DEFAULT_OUTBOX_LEASE_DURATION_MS,
  defaultOutboxRetryPolicy,
  OUTBOX_HANDLER_FAILED_ERROR_CODE,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_RETRY_BACKOFF_BASE_MS,
  OUTBOX_RETRY_BACKOFF_MAX_MS,
  outboxRetryBackoffMs,
  type OutboxRetryPolicy,
} from './retry-policy.js';
export {
  createConsoleOutboxLogger,
  outboxErrorClassOf,
  type OutboxConsumerLogFields,
  type OutboxConsumerLogger,
  type OutboxConsumerOutcome,
} from './logging.js';
export {
  CLAIM_OUTBOX_EVENT_SQL,
  createOutboxConsumer,
  createOutboxConsumerFromPool,
  HANDLER_SAVEPOINT,
  MARK_OUTBOX_EVENT_PROCESSED_SQL,
  RECORD_OUTBOX_EVENT_FAILURE_SQL,
  type DrainOutboxOptions,
  type DrainOutboxResult,
  type OutboxConsumer,
  type OutboxConsumerDependencies,
} from './consumer.js';
