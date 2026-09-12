import { createChangeMembershipRoleFromPool } from './application/home-administration/change-membership-role.js';
import { createArchiveFinalMemberHomeFromPool } from './application/home-administration/archive-final-member-home.js';
import { createLeaveMembershipFromPool } from './application/home-administration/leave-membership.js';
import { createRemoveMembershipFromPool } from './application/home-administration/remove-membership.js';
import { createHomeRepository } from './domains/homes/index.js';
import { createActiveHomeActorResolver } from './domains/memberships/index.js';
import { createRoomiesApiRouter } from './http/create-roomies-api.js';
import {
  createCanonicalUserLookup,
  createPrincipalResolver,
} from './platform/auth/principal.js';
import { createAuthRuntime } from './platform/auth/runtime.js';
import { loadConfig } from './platform/config/index.js';
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
  const principalResolver = createPrincipalResolver({
    auth,
    hasCanonicalUser: createCanonicalUserLookup(databasePool.pool),
  });
  const activeHomeActorResolver = createActiveHomeActorResolver(
    databasePool.pool,
  );
  const homeReader = createHomeRepository(databasePool.pool);
  const readiness = createDbReadiness(db);
  const app = createApp({
    config,
    readiness,
    auth,
    roomiesApi: createRoomiesApiRouter({
      principalResolver,
      activeHomeActorResolver,
      homeReader,
      archiveFinalMemberHome: createArchiveFinalMemberHomeFromPool(
        databasePool.pool,
      ),
      changeMembershipRole: createChangeMembershipRoleFromPool(
        databasePool.pool,
      ),
      leaveMembership: createLeaveMembershipFromPool(databasePool.pool),
      removeMembership: createRemoveMembershipFromPool(databasePool.pool),
    }),
  });

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
