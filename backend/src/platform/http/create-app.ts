import express, { type Express, type Router } from 'express';
import helmet from 'helmet';
import { AUTH_HTTP_ROUTE, createAuthHttpHandler } from '../auth/http.js';
import type { AuthRuntime } from '../auth/runtime.js';
import type { AppConfig } from '../config/types.js';
import type { PersistenceReadiness } from '../persistence/readiness.js';
import { JSON_BODY_LIMIT } from './constants.js';
import { createCorsMiddleware } from './cors.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { createHealthRouter } from './health.js';
import { requestIdMiddleware } from './request-id.js';

export type CreateAppOptions = {
  config: Pick<AppConfig, 'trustedOrigins' | 'trustProxyHops'>;
  readiness: PersistenceReadiness;
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
  const app = express();

  // Explicit hop count — never unrestricted `true`. Matters later for secure
  // cookies, req.ip / rate limits, and HTTPS awareness behind Railway.
  app.set('trust proxy', config.trustProxyHops);

  app.disable('x-powered-by');

  app.use(requestIdMiddleware);
  app.use(helmet());
  app.use(createCorsMiddleware(config.trustedOrigins));

  // Better Auth must see the native request body. Roomies JSON parsing
  // is mounted after `/api/auth/*` and applies only to later routes.
  if (auth) {
    app.all(AUTH_HTTP_ROUTE, createAuthHttpHandler(auth));
  }

  // Syntactically valid JSON, including primitives such as `null`, must reach
  // endpoint Zod schemas. `strict: false` keeps malformed JSON as a parser
  // failure (BAD_REQUEST) and does not classify wrong shapes here.
  app.use(express.json({ limit: JSON_BODY_LIMIT, strict: false }));

  app.use(createHealthRouter(readiness));

  app.use('/api/v1', roomiesApi ?? express.Router());

  configure?.(app);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
