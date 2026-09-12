import type { RequestHandler } from 'express';

/**
 * Smallest private-API cache policy: authenticated bodies must not be
 * stored by shared caches. No ETag or cache infrastructure.
 */
export const setPrivateNoStoreHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
};

/**
 * Express may still attach a weak ETag when sending JSON. Invitation preview
 * must not be cacheable or validator-addressable.
 */
export const stripResponseEtag: RequestHandler = (_req, res, next) => {
  const end = res.end.bind(res);
  res.end = ((chunk?: unknown, encoding?: unknown, callback?: unknown) => {
    res.removeHeader('ETag');
    return end(
      chunk as Parameters<typeof res.end>[0],
      encoding as Parameters<typeof res.end>[1],
      callback as Parameters<typeof res.end>[2],
    );
  }) as typeof res.end;
  next();
};
