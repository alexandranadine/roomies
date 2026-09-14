import { TransactionInfrastructureError } from './errors.js';

/**
 * Bounded retry for expected PostgreSQL serialization failures (SQLSTATE
 * 40001). Each attempt must start a completely new transaction.
 */
export const SERIALIZATION_RETRY_MAX_ATTEMPTS = 3;

export function isPostgresSerializationFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '40001'
  );
}

/**
 * Retry `work` when PostgreSQL reports a serialization failure.
 * Exhausted retries become a content-free infrastructure error.
 */
export async function runWithBoundedSerializationRetry<T>(
  work: () => Promise<T>,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await work();
    } catch (error) {
      attempt += 1;
      if (
        !isPostgresSerializationFailure(error) ||
        attempt >= SERIALIZATION_RETRY_MAX_ATTEMPTS
      ) {
        if (
          isPostgresSerializationFailure(error) &&
          attempt >= SERIALIZATION_RETRY_MAX_ATTEMPTS
        ) {
          throw new TransactionInfrastructureError();
        }
        throw error;
      }
    }
  }
}
