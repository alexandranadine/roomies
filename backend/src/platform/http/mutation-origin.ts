import type { Request, RequestHandler, Response } from 'express';
import { normalizeTrustedOrigin } from '../config/normalize-origin.js';
import type { ApiErrorBody } from './errors.js';
import { getRequestId } from './request-id.js';

/**
 * Cookie-authenticated /api/v1 CSRF model (Roomies v1):
 *
 * - Session auth uses HttpOnly cookies. A hostile page can cause the browser
 *   to send those cookies on cross-site mutations.
 * - The October client is the browser frontend, served only from configured
 *   trusted origins. Browsers always attach Origin on cross-origin POST/PUT/
 *   PATCH/DELETE.
 * - This guard requires an exact trusted Origin on unsafe /api/v1 methods
 *   (same normalizeTrustedOrigin + Set membership semantics as config/CORS).
 *   FRONTEND_ORIGIN is not an authorization input.
 * - Hostile sites therefore cannot cause an accepted mutation. CORS still only
 *   controls response sharing (withholding ACAO). It does not reject the
 *   request and is not CSRF protection.
 * - SameSite cookies remain defense-in-depth, not the sole CSRF control.
 * - Missing Origin is rejected: curl/Postman omission is not a supported
 *   browser mutation path, and no current production client calls /api/v1
 *   mutations without Origin.
 */
export const API_MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Reject untrusted or missing Origin on /api/v1 unsafe methods before route
 * handlers or mutation side effects. Safe methods and OPTIONS pass through.
 */
export function createApiMutationOriginGuard(
  trustedOrigins: readonly string[],
): RequestHandler {
  const allowed = new Set(trustedOrigins);

  return (req, res, next) => {
    if (!API_MUTATION_METHODS.has(req.method.toUpperCase())) {
      next();
      return;
    }

    const origin = readOriginHeader(req);
    if (origin === undefined) {
      rejectUntrustedMutationOrigin(req, res);
      return;
    }

    let normalized: string;
    try {
      normalized = normalizeTrustedOrigin(origin);
    } catch {
      rejectUntrustedMutationOrigin(req, res);
      return;
    }

    if (!allowed.has(normalized)) {
      rejectUntrustedMutationOrigin(req, res);
      return;
    }

    next();
  };
}

function readOriginHeader(req: Request): string | undefined {
  const raw = req.headers.origin;
  if (typeof raw !== 'string' || raw.length === 0) {
    return undefined;
  }
  return raw;
}

function rejectUntrustedMutationOrigin(req: Request, res: Response): void {
  const body: ApiErrorBody = {
    error: {
      code: 'FORBIDDEN',
      message: 'Forbidden',
      requestId: getRequestId(req),
    },
  };
  res.status(403).json(body);
}
