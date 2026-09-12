import cors from 'cors';
import type { RequestHandler } from 'express';
import { normalizeTrustedOrigin } from '../config/normalize-origin.js';

/**
 * Exact-origin CORS from configured trusted origins.
 * Credentials-compatible (no wildcard). Requests without Origin remain allowed
 * (health probes / server-to-server). Unknown origins are denied without reflecting
 * the request Origin — CORS withholds ACAO; it does not reject the request
 * and is not CSRF protection. `/api/v1` mutation origin enforcement lives in
 * `createApiMutationOriginGuard`.
 */
export function createCorsMiddleware(
  trustedOrigins: readonly string[],
): RequestHandler {
  const allowed = new Set(trustedOrigins);

  return cors({
    credentials: true,
    origin(origin, callback) {
      if (origin === undefined || origin === '') {
        callback(null, true);
        return;
      }

      let normalized: string;
      try {
        normalized = normalizeTrustedOrigin(origin);
      } catch {
        callback(null, false);
        return;
      }

      if (allowed.has(normalized)) {
        // Pass the normalized configured origin (not an arbitrary reflection).
        callback(null, normalized);
        return;
      }

      callback(null, false);
    },
  });
}
