/** Response header carrying the per-request observability ID. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Conservative JSON body size for normal Roomies API mutations (no uploads).
 * Oversized bodies are rejected by Express body parsing.
 */
export const JSON_BODY_LIMIT = '32kb';

/** Bound how long graceful shutdown waits for in-flight HTTP work + DB close. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;
