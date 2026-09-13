import { createCreateHomeFromPool } from './application/homes/create-home.js';
import { createChangeMembershipRoleFromPool } from './application/home-administration/change-membership-role.js';
import { createArchiveFinalMemberHomeFromPool } from './application/home-administration/archive-final-member-home.js';
import { createCreateInvitationFromPool } from './application/home-administration/create-invitation.js';
import { createRevokeInvitationFromPool } from './application/home-administration/revoke-invitation.js';
import { createAcceptInvitationFromPool } from './application/invitations/accept-invitation.js';
import { createPreviewInvitationFromPool } from './application/invitations/preview-invitation.js';
import { createLeaveMembershipFromPool } from './application/home-administration/leave-membership.js';
import { createRemoveMembershipFromPool } from './application/home-administration/remove-membership.js';
import { createCompleteTaskFromPool } from './application/tasks/complete-task.js';
import { createCreateManualTaskFromPool } from './application/tasks/create-manual-task.js';
import { createCreateRecurringTaskDefinitionFromPool } from './application/tasks/create-recurring-task-definition.js';
import { createDeactivateTaskDefinitionFromPool } from './application/tasks/deactivate-task-definition.js';
import { createListHomeTaskDefinitionsFromPool } from './application/tasks/list-home-task-definitions.js';
import { createListHomeTasksFromPool } from './application/tasks/list-home-tasks.js';
import {
  createActiveHomesForUserReader,
  createHomeRepository,
  listActiveHomesForUser,
} from './domains/homes/index.js';
import { createActiveHomeActorResolver } from './domains/memberships/index.js';
import { createRoomiesApiRouter } from './http/create-roomies-api.js';
import {
  createCanonicalUserLookup,
  createPrincipalResolver,
} from './platform/auth/principal.js';
import { createAuthRuntime } from './platform/auth/runtime.js';
import { loadConfig } from './platform/config/index.js';
import type {
  AppConfig,
  ProcessRuntimeConfig,
} from './platform/config/types.js';
import { createApp } from './platform/http/create-app.js';
import {
  createDatabasePool,
  type DatabasePoolRuntime,
} from './platform/persistence/pool.js';
import { createDbReadiness } from './platform/persistence/readiness.js';
import {
  startsHttpServer,
  startsRecurrenceWorker,
} from './platform/runtime/process-mode.js';
import { startProcess } from './platform/runtime/start-process.js';
import type { ClosableResource } from './platform/server/start-http-server.js';
import { startHttpServer } from './platform/server/start-http-server.js';
import { createRecurrenceWorkerFromPool } from './platform/workers/create-recurrence-worker-from-pool.js';
import { createDb } from './prisma/db.js';

type RuntimeConfig = AppConfig & ProcessRuntimeConfig;

function createWebHttpRuntime(
  config: RuntimeConfig,
  databasePool: DatabasePoolRuntime,
  resources: ClosableResource[],
) {
  const db = createDb(databasePool.pool);
  resources.unshift(db);
  const auth = createAuthRuntime(databasePool.pool, config);
  const principalResolver = createPrincipalResolver({
    auth,
    hasCanonicalUser: createCanonicalUserLookup(databasePool.pool),
  });
  const activeHomeActorResolver = createActiveHomeActorResolver(
    databasePool.pool,
  );
  const homeReader = createHomeRepository(databasePool.pool);
  const activeHomesForUserReader = createActiveHomesForUserReader(
    databasePool.pool,
  );
  const readiness = createDbReadiness(db);
  const app = createApp({
    config,
    readiness,
    auth,
    roomiesApi: createRoomiesApiRouter({
      principalResolver,
      activeHomeActorResolver,
      homeReader,
      createHome: createCreateHomeFromPool(databasePool.pool),
      listActiveHomes: (input) =>
        listActiveHomesForUser(input, activeHomesForUserReader),
      archiveFinalMemberHome: createArchiveFinalMemberHomeFromPool(
        databasePool.pool,
      ),
      changeMembershipRole: createChangeMembershipRoleFromPool(
        databasePool.pool,
      ),
      leaveMembership: createLeaveMembershipFromPool(databasePool.pool),
      removeMembership: createRemoveMembershipFromPool(databasePool.pool),
      invitations: {
        createInvitation: createCreateInvitationFromPool(databasePool.pool),
        revokeInvitation: createRevokeInvitationFromPool(databasePool.pool),
        frontendOrigin: config.frontendOrigin,
      },
      previewInvitation: createPreviewInvitationFromPool(databasePool.pool),
      acceptInvitation: createAcceptInvitationFromPool(databasePool.pool),
      tasks: {
        createManualTask: createCreateManualTaskFromPool(databasePool.pool),
        listHomeTasks: createListHomeTasksFromPool(databasePool.pool),
        completeTask: createCompleteTaskFromPool(databasePool.pool),
        createRecurringTaskDefinition:
          createCreateRecurringTaskDefinitionFromPool(databasePool.pool),
        listHomeTaskDefinitions: createListHomeTaskDefinitionsFromPool(
          databasePool.pool,
        ),
        deactivateTaskDefinition: createDeactivateTaskDefinitionFromPool(
          databasePool.pool,
        ),
      },
    }),
  });

  return startHttpServer({
    app,
    port: config.port,
    resources: [],
    installSignalHandlers: false,
  });
}

/**
 * Process entrypoint.
 *
 * Startup sequence:
 * 1. load validated config once, including PROCESS_MODE
 * 2. create the process-owned PostgreSQL pool
 * 3. start HTTP and/or the recurrence worker from that same pool
 * 4. own SIGTERM/SIGINT and close the pool exactly once after collaborators stop
 *
 * DB connectivity is not required to bind the HTTP port. Transient DB
 * unavailability keeps `/ready` at 503 instead of crashing the process into a
 * restart loop. Worker-only mode does not listen for HTTP.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const databasePool = createDatabasePool(config);
  let poolClosed = false;
  const resources: ClosableResource[] = [
    {
      async close() {
        poolClosed = true;
        await databasePool.close();
      },
    },
  ];

  try {
    startProcess({
      mode: config.processMode,
      resources,
      createHttp: startsHttpServer(config.processMode)
        ? () => createWebHttpRuntime(config, databasePool, resources)
        : undefined,
      createWorker: startsRecurrenceWorker(config.processMode)
        ? () =>
            createRecurrenceWorkerFromPool(databasePool.pool, {
              pollIntervalMs: config.recurrencePollIntervalMs,
              isInfrastructureClosed: () => poolClosed,
            })
        : undefined,
    });
  } catch (error) {
    for (const resource of resources) {
      await resource.close();
    }
    throw error;
  }
}

void main().catch((error: unknown) => {
  console.error('[process] startup failed');
  // Avoid logging raw env/secret material if a ConfigError wraps issues only.
  if (error instanceof Error && error.message.length > 0) {
    console.error(error.message);
  }
  process.exit(1);
});
