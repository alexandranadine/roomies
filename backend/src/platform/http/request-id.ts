import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { REQUEST_ID_HEADER } from './constants.js';

/**
 * Request IDs are observability correlation tokens, not persistent domain IDs.
 * Domain entities use Prisma UUIDv7 generators; here we use Node's cryptographically
 * suitable UUIDv4 (`randomUUID`) so request IDs stay decoupled from entity-ID policy.
 */
export type RequestWithId = Request & {
  requestId: string;
};

export function getRequestId(req: Request): string {
  const id = (req as RequestWithId).requestId;
  if (typeof id !== 'string' || id.length === 0) {
    // Middleware always assigns an ID before handlers run.
    return 'missing-request-id';
  }
  return id;
}

/**
 * Assign a fresh server-generated request ID on every request.
 * Client-supplied IDs are ignored (not blindly trusted).
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = randomUUID();
  (req as RequestWithId).requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  next();
}
