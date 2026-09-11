import { loadConfig } from './platform/config/index.js';
import { createAuthRuntime } from './platform/auth/runtime.js';
import { createApp } from './platform/http/create-app.js';
import { createDatabasePool } from './platform/persistence/pool.js';
import { createDbReadiness } from './platform/persistence/readiness.js';
import { startHttpServer } from './platform/server/start-http-server.js';
import { createDb } from './prisma/db.js';

/**
 * Web process entrypoint.
 *
 * Startup sequence:
 * 1. load validated config once
 * 2. create the process-owned PostgreSQL pool
 * 3. create Prisma and Better Auth over that same pool
 * 4. create Express app
 * 5. start HTTP server
 *
 * DB connectivity is not required to bind the port. Transient DB unavailability
 * keeps `/ready` at 503 instead of crashing the process into a restart loop.
 */
function main(): void {
  const config = loadConfig();
  const databasePool = createDatabasePool(config);
  const db = createDb(databasePool.pool);
  const auth = createAuthRuntime(databasePool.pool, config);
  // Route mounting is intentionally deferred to M1.3c.
  void auth;
  const readiness = createDbReadiness(db);
  const app = createApp({ config, readiness });

  startHttpServer({
    app,
    port: config.port,
    resources: [db, databasePool],
  });
}

try {
  main();
} catch (error: unknown) {
  console.error('[http] startup failed');
  // Avoid logging raw env/secret material if a ConfigError wraps issues only.
  if (error instanceof Error && error.message.length > 0) {
    console.error(error.message);
  }
  process.exit(1);
}
