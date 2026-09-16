/**
 * Thrown when a limiter class rejects a request. Mapped to HTTP 429
 * `RATE_LIMITED` by the platform error boundary. Contains no identity,
 * email, token, or bucket key.
 */
export class RateLimitedError extends Error {
  override readonly name = 'RateLimitedError';

  constructor(readonly retryAfterSeconds: number) {
    super('Too many requests');
  }
}
