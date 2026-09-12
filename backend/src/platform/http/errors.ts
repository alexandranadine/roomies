import type { NextFunction, Request, Response } from 'express';
import {
  AuthInfrastructureError,
  UnauthenticatedError,
} from '../auth/errors.js';
import {
  AuthorizationIntegrityError,
  ConcealedNotFoundError,
  ForbiddenError,
  InvalidPathInputError,
} from '../authz/errors.js';
import { TransactionInfrastructureError } from '../persistence/errors.js';
import { StructuralIntegrityError } from '../../domains/homes/structure-errors.js';
import { getRequestId } from './request-id.js';

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
};

function sendApiError(
  res: Response,
  status: number,
  code: string,
  message: string,
  requestId: string,
): void {
  const body: ApiErrorBody = {
    error: { code, message, requestId },
  };
  res.status(status).json(body);
}

function isExpressPayloadTooLarge(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const status =
    'status' in err && typeof err.status === 'number' ? err.status : undefined;
  const statusCode =
    'statusCode' in err && typeof err.statusCode === 'number'
      ? err.statusCode
      : undefined;
  return status === 413 || statusCode === 413;
}

function isEntityParseFailed(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    err.type === 'entity.parse.failed'
  );
}

/** Generic safe 404 for unmatched routes (no Maintenance privacy behavior). */
export function notFoundHandler(req: Request, res: Response): void {
  sendApiError(res, 404, 'NOT_FOUND', 'Not found', getRequestId(req));
}

/**
 * Final error handler: unexpected failures become safe INTERNAL_ERROR responses.
 * Does not leak stack traces, raw exception messages, or infrastructure details.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // Express requires the 4-arg signature to treat this as an error middleware.
  next: NextFunction,
): void {
  // Keep `next` referenced so the 4-arg signature is preserved under lint.
  void next;

  const requestId = getRequestId(req);

  if (res.headersSent) {
    return;
  }

  const routeCategory = requestPathCategory(req);

  // Body-parser / entity-too-large → safe 413 without echoing body contents.
  if (isExpressPayloadTooLarge(err)) {
    sendApiError(
      res,
      413,
      'PAYLOAD_TOO_LARGE',
      'Request body too large',
      requestId,
    );
    return;
  }

  // Malformed JSON → safe 400.
  if (isEntityParseFailed(err)) {
    sendApiError(res, 400, 'BAD_REQUEST', 'Invalid JSON body', requestId);
    return;
  }

  if (err instanceof UnauthenticatedError) {
    sendApiError(
      res,
      401,
      'UNAUTHENTICATED',
      'Authentication required',
      requestId,
    );
    return;
  }

  if (err instanceof InvalidPathInputError) {
    sendApiError(
      res,
      400,
      'INVALID_PATH_INPUT',
      'Invalid path input',
      requestId,
    );
    return;
  }

  if (err instanceof ForbiddenError) {
    sendApiError(res, 403, 'FORBIDDEN', 'Forbidden', requestId);
    return;
  }

  if (err instanceof ConcealedNotFoundError) {
    sendApiError(res, 404, 'NOT_FOUND', 'Not found', requestId);
    return;
  }

  if (
    err instanceof AuthorizationIntegrityError ||
    err instanceof StructuralIntegrityError ||
    err instanceof TransactionInfrastructureError ||
    err instanceof AuthInfrastructureError
  ) {
    console.error('[http] request failed', {
      requestId,
      routeCategory,
      status: 500,
      errorClass: err.name,
    });
    sendApiError(
      res,
      500,
      'INTERNAL_ERROR',
      'An unexpected error occurred',
      requestId,
    );
    return;
  }

  // Content-free diagnostics only: no URL query, headers, body, or exception text.
  // Arbitrary objects with status/code/message do not control the response.
  console.error('[http] request failed', {
    requestId,
    routeCategory,
    status: 500,
  });

  sendApiError(
    res,
    500,
    'INTERNAL_ERROR',
    'An unexpected error occurred',
    requestId,
  );
}

function requestPathCategory(req: Request): 'auth' | 'api' | 'other' {
  const raw = req.originalUrl ?? req.url ?? '';
  const path = raw.split('?')[0] ?? '';
  if (path.startsWith('/api/auth')) {
    return 'auth';
  }
  if (path.startsWith('/api/v1')) {
    return 'api';
  }
  return 'other';
}
