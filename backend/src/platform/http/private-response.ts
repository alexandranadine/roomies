import type { RequestHandler } from 'express';

/**
 * Smallest private-API cache policy: authenticated bodies must not be
 * stored by shared caches. No ETag or cache infrastructure.
 */
export const setPrivateNoStoreHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
};
