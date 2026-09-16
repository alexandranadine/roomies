import type { RequestHandler } from 'express';
import helmet from 'helmet';

/**
 * API security headers. The backend serves JSON, not HTML documents, so Helmet
 * CSP is disabled: browser document CSP belongs on the frontend origin.
 *
 * HSTS is enabled only when cookies are already marked Secure (preview,
 * staging, and production). Local HTTP development must not advertise HSTS.
 */
export function createSecurityHeadersMiddleware(input: {
  enableHsts: boolean;
}): RequestHandler[] {
  return [
    helmet({
      contentSecurityPolicy: false,
      strictTransportSecurity: input.enableHsts
        ? { maxAge: 15_552_000, includeSubDomains: true }
        : false,
      xFrameOptions: { action: 'deny' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
    (_req, res, next) => {
      res.setHeader(
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=(), payment=()',
      );
      next();
    },
  ];
}
