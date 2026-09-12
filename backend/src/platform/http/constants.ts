/** Response header carrying the per-request observability ID. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Conservative JSON body size for normal Roomies API mutations (no uploads).
 * Oversized bodies are rejected by Express body parsing.
 */
export const JSON_BODY_LIMIT = '32kb';

/** Bound how long graceful shutdown waits for in-flight HTTP work + DB close. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Explicit HTTP pipeline order. Health/ready stay after JSON (they do not
 * consume bodies) and before `/api/v1`. Credential rate limiting is not
 * implemented yet and is required before public launch.
 *
 * `api-mutation-origin` runs after request IDs / CORS / Better Auth and
 * before JSON parsing so hostile `/api/v1` mutations die without body work.
 */
export const HTTP_PIPELINE_ORDER = [
  'trust-proxy',
  'request-id',
  'security-headers',
  'cors',
  'better-auth',
  'api-mutation-origin',
  'json-body',
  'health',
  'roomies-api',
  'not-found',
  'error-boundary',
] as const;
