export const OUTBOX_MAX_ATTEMPTS = 8;
export const OUTBOX_RETRY_BACKOFF_BASE_MS = 1_000;
export const OUTBOX_RETRY_BACKOFF_MAX_MS = 60_000;
export const DEFAULT_OUTBOX_BATCH_SIZE = 25;
export const DEFAULT_OUTBOX_LEASE_DURATION_MS = 30_000;

export const OUTBOX_HANDLER_FAILED_ERROR_CODE = 'HANDLER_FAILED';

export type OutboxRetryPolicy = Readonly<{
  maxAttempts: number;
  backoffMs: (attemptCount: number) => number;
}>;

/**
 * Deterministic exponential backoff after a failed attempt.
 * attemptCount is the count after increment (1-based failure count).
 */
export function outboxRetryBackoffMs(attemptCount: number): number {
  let delay = OUTBOX_RETRY_BACKOFF_BASE_MS;
  for (let step = 1; step < attemptCount; step += 1) {
    delay = Math.min(delay * 2, OUTBOX_RETRY_BACKOFF_MAX_MS);
  }
  return delay;
}

export const defaultOutboxRetryPolicy: OutboxRetryPolicy = Object.freeze({
  maxAttempts: OUTBOX_MAX_ATTEMPTS,
  backoffMs: outboxRetryBackoffMs,
});
