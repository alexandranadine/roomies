import { loadConfig } from './platform/config/index.js';
import { createApp } from './platform/http/create-app.js';
import { createDbReadiness } from './platform/persistence/readiness.js';
import { startHttpServer } from './platform/server/start-http-server.js';
import { createDb } from './prisma/db.js';

/**
 * Web process entrypoint.
 *
 * Startup sequence:
 * 1. load validated config once
 * 2. create DB client
 * 3. create Express app
 * 4. start HTTP server
 *
 * DB connectivity is not required to bind the port. Transient DB unavailability
 * keeps `/ready` at 503 instead of crashing the process into a restart loop.
 */
function main(): void {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const readiness = createDbReadiness(db);
  const app = createApp({ config, readiness });

  startHttpServer({
    app,
    port: config.port,
    resources: [db],
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
