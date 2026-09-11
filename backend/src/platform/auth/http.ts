import type { Request, RequestHandler } from 'express';
import {
  createAuthNodeHandler,
  type AuthRuntime,
} from '../../../auth-runtime/src/index.js';
import { getRequestId } from '../http/request-id.js';

/** Express 5 named wildcard for `/api/auth/*`. */
export const AUTH_HTTP_ROUTE = '/api/auth/*splat';

export const AUTH_HTTP_PATH_PREFIX = '/api/auth';

function logAuthHttpFailure(req: Request, errorClass: string): void {
  console.error('[auth] http failure', {
    requestId: getRequestId(req),
    routeCategory: 'auth',
    status: 500,
    errorClass,
  });
}

/**
 * Wrap Better Auth's official Node handler.
 *
 * Expected Better Auth responses are passed through unchanged. Unexpected
 * throws become Roomies error-boundary failures (no SQL/stack/secret leak).
 */
export function createAuthHttpHandler(auth: AuthRuntime): RequestHandler {
  const handle = createAuthNodeHandler(auth);

  return (req, res, next) => {
    void handle(req, res).catch((error: unknown) => {
      const errorClass =
        error instanceof Error ? error.constructor.name : 'unknown';
      logAuthHttpFailure(req, errorClass);
      next(error);
    });
  };
}
