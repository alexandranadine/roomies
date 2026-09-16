import express, { type Express, type Router } from 'express';
import { AUTH_HTTP_ROUTE, createAuthHttpHandler } from '../auth/http.js';
import type { AuthRuntime } from '../auth/runtime.js';
import type { AppConfig } from '../config/types.js';
import type { PersistenceReadiness } from '../persistence/readiness.js';
import { JSON_BODY_LIMIT } from './constants.js';
import { createCorsMiddleware } from './cors.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { createHealthRouter } from './health.js';
import { createApiMutationOriginGuard } from './mutation-origin.js';
import {
  createCredentialAuthRateLimit,
  createInMemoryRateLimitRuntime,
  type RateLimitRuntime,
} from './rate-limit.js';
import { createTrustedCloudflareIngressMiddleware } from './trusted-cloudflare-ingress.js';
import { requestIdMiddleware } from './request-id.js';
import { createSecurityHeadersMiddleware } from './security-headers.js';

export type CreateAppOptions = {
  config: Pick<AppConfig, 'trustedOrigins' | 'trustProxyHops'> &
    Partial<Pick<AppConfig, 'secureAuthCookies' | 'releaseSha' | 'ingress'>>;
  readiness: PersistenceReadiness;
  /**
   * In-process limiter used for Better Auth credential routes. Product
   * routers receive the same runtime for sensitive/invitation classes.
   */
  rateLimits?: RateLimitRuntime;
  /** Isolated Better Auth runtime. Mounted at `/api/auth/*` before JSON parsing. */
  auth?: AuthRuntime;
  /**
   * Product API mounted at `/api/v1`. Auth is applied by the composed router,
   * not globally — health and `/api/auth` stay unauthenticated.
   */
  roomiesApi?: Router;
  /**
   * Optional composition hook (e.g. tests mounting a throwing route).
   * Runs after platform routes and before the 404/error handlers.
   */
  configure?: (app: Express) => void;
};

/**
 * Build the Express application without binding a network port.
 * Tests and the server runtime both consume this factory.
 */
export function createApp(options: CreateAppOptions): Express {
  const { config, readiness, auth, roomiesApi, configure } = options;
  const rateLimits = options.rateLimits ?? createInMemoryRateLimitRuntime();
  const app = express();

  // Explicit hop count — never unrestricted `true`. Matters later for secure
  // cookies, req.ip / rate limits, and HTTPS awareness behind Railway.
  app.set('trust proxy', config.trustProxyHops);

  app.disable('x-powered-by');

  app.use(requestIdMiddleware);
  app.use(
    ...createSecurityHeadersMiddleware({
      enableHsts: config.secureAuthCookies === true,
    }),
  );
  app.use(createCorsMiddleware(config.trustedOrigins));

  // Cloudflare origin authentication must run after CORS so 403s still
  // carry ACAO for trusted origins, and before credential/product work.
  if (config.ingress?.mode === 'cloudflare') {
    app.use(
      createTrustedCloudflareIngressMiddleware(config.ingress.originAuthSecret),
    );
  }

  // Better Auth must see the native request body. Roomies JSON parsing
  // is mounted after `/api/auth/*` and applies only to later routes.
  // Credential rate limiting wraps matching POST paths only; session lookup
  // and /ok are not credential-throttled.
  if (auth) {
    app.all(
      AUTH_HTTP_ROUTE,
      createCredentialAuthRateLimit(rateLimits),
      createAuthHttpHandler(auth),
    );
  }

  // Cookie CSRF: reject untrusted/missing Origin on /api/v1 mutations after
  // request IDs exist and before JSON parsing or application handlers.
  // /api/auth/* is not wrapped — Better Auth owns its own origin checks.
  app.use('/api/v1', createApiMutationOriginGuard(config.trustedOrigins));

  // Syntactically valid JSON, including primitives such as `null`, must reach
  // endpoint Zod schemas. `strict: false` keeps malformed JSON as a parser
  // failure (BAD_REQUEST) and does not classify wrong shapes here.
  app.use(express.json({ limit: JSON_BODY_LIMIT, strict: false }));

  app.use(createHealthRouter(readiness, { releaseSha: config.releaseSha }));

  app.use('/api/v1', roomiesApi ?? express.Router());

  configure?.(app);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
