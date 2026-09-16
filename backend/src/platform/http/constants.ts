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
 * consume bodies) and before `/api/v1`. Credential rate limiting wraps
 * matching Better Auth POST paths immediately before the auth handler.
 * Sensitive/invitation classes are applied inside `/api/v1` routers after
 * authentication where a userId key is required.
 *
 * `cloudflare-ingress` is mounted only when `INGRESS_MODE=cloudflare`. It
 * authenticates the overwritten origin-auth secret, then stores a trusted
 * `CF-Connecting-IP`. GET `/health` and GET `/ready` skip that requirement
 * and never receive a trusted client identity. Direct ingress omits this
 * step and keeps Express `req.ip` as the limiter identity.
 *
 * `api-mutation-origin` runs after request IDs / CORS / Better Auth and
 * before JSON parsing so hostile `/api/v1` mutations die without body work.
 */
export const HTTP_PIPELINE_ORDER = [
  'trust-proxy',
  'request-id',
  'security-headers',
  'cors',
  'cloudflare-ingress',
  'credential-rate-limit',
  'better-auth',
  'api-mutation-origin',
  'json-body',
  'health',
  'roomies-api',
  'not-found',
  'error-boundary',
] as const;
