import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createListHomeActivityFromPool } from '../../application/activity/list-home-activity.js';
import { createListHomeMaintenanceFromPool } from '../../application/maintenance/list-home-maintenance.js';
import { createReadMaintenanceEntryFromPool } from '../../application/maintenance/read-maintenance-entry.js';
import { createListActiveHomeMembershipsFromPool } from '../../application/memberships/list-active-home-memberships.js';
import { createGetHousePulseFromPool } from '../../application/pulse/get-house-pulse.js';
import { createListHomeSuppliesFromPool } from '../../application/supplies/list-home-supplies.js';
import { createListHomeTaskDefinitionsFromPool } from '../../application/tasks/list-home-task-definitions.js';
import { createListHomeTasksFromPool } from '../../application/tasks/list-home-tasks.js';
import { createRoomiesApiRouter } from '../../http/create-roomies-api.js';
import {
  createCanonicalUserLookup,
  createPrincipalResolver,
} from '../../platform/auth/principal.js';
import { createAuthRuntime } from '../../platform/auth/runtime.js';
import type { AppConfig } from '../../platform/config/types.js';
import { withAppServer } from '../../platform/http/app-request.test-helper.js';
import { createApp } from '../../platform/http/create-app.js';
import type { ApiErrorBody } from '../../platform/http/errors.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import { createDbReadiness } from '../../platform/persistence/readiness.js';
import { resolveTestDatabaseUrl } from '../../platform/persistence/test-database.js';
import { createDb } from '../../prisma/db.js';
import {
  createActiveHomesForUserReader,
  createHomeRepository,
  listActiveHomesForUser,
} from '../homes/index.js';
import { createActiveHomeActorResolver } from './active-home-actor-resolver.js';
import { activeHomeMembershipsDtoSchema } from './active-home-membership-dto.js';

const TEST_SECRET = 'roomies_test_secret_32_chars_minimum_value';
const TRUSTED_ORIGIN = 'http://localhost:5173';
const PASSWORD = 'test-password-only';

const skipWithoutDatabase =
  !process.env['TEST_DATABASE_URL'] && !process.env['DATABASE_URL']
    ? 'requires a migrated PostgreSQL test database'
    : false;

function authConfig(databaseUrl: string): AppConfig {
  return {
    appEnv: 'test',
    port: 3000,
    databaseUrl,
    authBaseUrl: 'http://localhost:3000',
    authSecret: TEST_SECRET,
    secureAuthCookies: false,
    frontendOrigin: TRUSTED_ORIGIN,
    trustedOrigins: [TRUSTED_ORIGIN],
    trustProxyHops: 0,
  };
}

function findSessionSetCookie(headers: Headers): string | undefined {
  return headers
    .getSetCookie()
    .find((cookie) => /session_token=/i.test(cookie.split(';')[0] ?? ''));
}

function sessionCookieHeader(setCookie: string): string {
  return setCookie.split(';', 1)[0] ?? '';
}

async function insertHome(pool: Pool, id: string, name: string): Promise<void> {
  await pool.query(
    `INSERT INTO homes (id, name, timezone, archived_at, updated_at)
     VALUES ($1, $2, 'UTC', NULL, NOW())`,
    [id, name],
  );
}

async function insertMembership(
  pool: Pool,
  input: {
    id: string;
    homeId: string;
    userId: string;
    role: 'ROOMMATE' | 'ADMIN';
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO memberships (id, home_id, user_id, role, ended_at, ended_by_membership_id)
     VALUES ($1, $2, $3, $4, NULL, NULL)`,
    [input.id, input.homeId, input.userId, input.role],
  );
}

function concealedShape(body: ApiErrorBody): {
  statusCode: string;
  message: string;
} {
  return { statusCode: body.error.code, message: body.error.message };
}

function neverRan(label: string) {
  return () => Promise.reject(new Error(`${label} must not run`));
}

void describe('ended Membership Home-surface HTTP isolation', () => {
  void it(
    'conceals Home-private surfaces for an ended tenure and restores only the new tenure after rejoin',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const databaseUrl = resolveTestDatabaseUrl();
      const config = authConfig(databaseUrl);
      const database = createDatabasePool(config);
      const db = createDb(database.pool);
      const auth = createAuthRuntime(database.pool, config);
      const principalResolver = createPrincipalResolver({
        auth,
        hasCanonicalUser: createCanonicalUserLookup(database.pool),
      });
      const homeId = randomUUID();
      const membershipStay = randomUUID();
      const membershipA = randomUUID();
      const membershipB = randomUUID();
      const identityIds: string[] = [];

      try {
        await db.connect();
        const app = createApp({
          config,
          readiness: createDbReadiness(db),
          auth,
          roomiesApi: createRoomiesApiRouter({
            principalResolver,
            activeHomeActorResolver: createActiveHomeActorResolver(
              database.pool,
            ),
            homeReader: createHomeRepository(database.pool),
            archiveFinalMemberHome: neverRan('archive'),
            changeMembershipRole: neverRan('change-role'),
            leaveMembership: neverRan('leave'),
            removeMembership: neverRan('remove'),
            listActiveHomes: (input) =>
              listActiveHomesForUser(
                input,
                createActiveHomesForUserReader(database.pool),
              ),
            listActiveHomeMemberships: createListActiveHomeMembershipsFromPool(
              database.pool,
            ),
            invitations: {
              createInvitation: neverRan('create-invitation'),
              revokeInvitation: neverRan('revoke-invitation'),
              frontendOrigin: TRUSTED_ORIGIN,
            },
            tasks: {
              createManualTask: neverRan('create-task'),
              listHomeTasks: createListHomeTasksFromPool(database.pool),
              completeTask: neverRan('complete-task'),
              createRecurringTaskDefinition: neverRan('create-definition'),
              listHomeTaskDefinitions: createListHomeTaskDefinitionsFromPool(
                database.pool,
              ),
              deactivateTaskDefinition: neverRan('deactivate-definition'),
            },
            supplies: {
              createSupplyEntry: neverRan('create-supply'),
              listHomeSupplies: createListHomeSuppliesFromPool(database.pool),
              claimSupplyEntry: neverRan('claim-supply'),
              releaseSupplyClaim: neverRan('release-supply'),
              markSupplyEntryObtained: neverRan('obtain-supply'),
              cancelSupplyEntry: neverRan('cancel-supply'),
            },
            maintenance: {
              createMaintenanceEntry: neverRan('create-maintenance'),
              listHomeMaintenance: createListHomeMaintenanceFromPool(
                database.pool,
              ),
              readMaintenanceEntry: createReadMaintenanceEntryFromPool(
                database.pool,
              ),
              resolveMaintenanceEntry: neverRan('resolve-maintenance'),
            },
            activity: {
              listHomeActivity: createListHomeActivityFromPool(database.pool),
            },
            pulse: {
              getHousePulse: createGetHousePulseFromPool(database.pool),
            },
          }),
        });

        await withAppServer(app, async (request) => {
          async function signUp(name: string) {
            const email = `ended-iso-${name}-${randomUUID()}@example.test`;
            const signup = await request({
              method: 'POST',
              path: '/api/auth/sign-up/email',
              headers: {
                Origin: TRUSTED_ORIGIN,
                'content-type': 'application/json',
              },
              body: JSON.stringify({ name, email, password: PASSWORD }),
            });
            assert.ok(signup.status >= 200 && signup.status < 300);
            const id = (signup.json() as { user?: { id?: string } }).user?.id;
            assert.ok(id);
            identityIds.push(id);
            const setCookie = findSessionSetCookie(signup.headers);
            assert.ok(setCookie);
            return { id, cookie: sessionCookieHeader(setCookie) };
          }

          const alex = await signUp('Alex');
          const jamie = await signUp('Jamie');
          await insertHome(database.pool, homeId, 'Isolation Home');
          await insertMembership(database.pool, {
            id: membershipStay,
            homeId,
            userId: jamie.id,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: membershipA,
            homeId,
            userId: alex.id,
            role: 'ADMIN',
          });

          const privatePaths = [
            `/api/v1/homes/${homeId}`,
            `/api/v1/homes/${homeId}/activity`,
            `/api/v1/homes/${homeId}/tasks`,
            `/api/v1/homes/${homeId}/supplies`,
            `/api/v1/homes/${homeId}/maintenance`,
            `/api/v1/homes/${homeId}/pulse`,
            `/api/v1/homes/${homeId}/memberships`,
          ];
          const mutationRequests = [
            {
              method: 'POST' as const,
              path: `/api/v1/homes/${homeId}/tasks`,
              body: JSON.stringify({ title: 'Nope' }),
            },
            {
              method: 'POST' as const,
              path: `/api/v1/homes/${homeId}/supplies`,
              body: JSON.stringify({ title: 'Nope' }),
            },
            {
              method: 'POST' as const,
              path: `/api/v1/homes/${homeId}/maintenance`,
              body: JSON.stringify({
                visibility: 'HOUSEHOLD',
                title: 'Nope',
              }),
            },
            {
              method: 'POST' as const,
              path: `/api/v1/homes/${homeId}/invitations`,
              body: JSON.stringify({ email: 'invite@example.test' }),
            },
          ];

          for (const path of privatePaths) {
            const res = await request({
              path,
              headers: { Cookie: alex.cookie },
            });
            assert.equal(res.status, 200, path);
          }
          const homesBefore = await request({
            path: '/api/v1/me/homes',
            headers: { Cookie: alex.cookie },
          });
          assert.equal(homesBefore.status, 200);
          assert.equal(
            (homesBefore.json() as { id: string }[]).some(
              (home) => home.id === homeId,
            ),
            true,
          );

          await database.pool.query(
            `UPDATE memberships
             SET ended_at = NOW(), ended_by_membership_id = $1
             WHERE id = $1`,
            [membershipA],
          );

          for (const path of privatePaths) {
            const res = await request({
              path,
              headers: { Cookie: alex.cookie },
            });
            assert.equal(res.status, 404, path);
            assert.deepEqual(concealedShape(res.json() as ApiErrorBody), {
              statusCode: 'NOT_FOUND',
              message: 'Not found',
            });
          }
          for (const mutation of mutationRequests) {
            const res = await request({
              method: mutation.method,
              path: mutation.path,
              headers: {
                Cookie: alex.cookie,
                Origin: TRUSTED_ORIGIN,
                'content-type': 'application/json',
              },
              body: mutation.body,
            });
            assert.equal(res.status, 404, mutation.path);
            assert.deepEqual(concealedShape(res.json() as ApiErrorBody), {
              statusCode: 'NOT_FOUND',
              message: 'Not found',
            });
          }
          const homesAfterLeave = await request({
            path: '/api/v1/me/homes',
            headers: { Cookie: alex.cookie },
          });
          assert.equal(homesAfterLeave.status, 200);
          assert.deepEqual(homesAfterLeave.json(), []);

          const stayMembers = await request({
            path: `/api/v1/homes/${homeId}/memberships`,
            headers: { Cookie: jamie.cookie },
          });
          assert.equal(stayMembers.status, 200);
          const stayBody = activeHomeMembershipsDtoSchema.parse(
            stayMembers.json(),
          );
          assert.equal(stayBody.currentMembershipId, membershipStay);
          assert.equal(
            stayBody.memberships.some(
              (row) => row.membershipId === membershipA,
            ),
            false,
          );

          await insertMembership(database.pool, {
            id: membershipB,
            homeId,
            userId: alex.id,
            role: 'ROOMMATE',
          });

          const homesAfterRejoin = await request({
            path: '/api/v1/me/homes',
            headers: { Cookie: alex.cookie },
          });
          assert.equal(homesAfterRejoin.status, 200);
          const rejoinedHomes = homesAfterRejoin.json() as {
            id: string;
            role: string;
          }[];
          assert.deepEqual(rejoinedHomes, [
            {
              id: homeId,
              role: 'ROOMMATE',
              timezone: 'UTC',
              hasPhoto: false,
              name: 'Isolation Home',
            },
          ]);

          const rejoinMembers = await request({
            path: `/api/v1/homes/${homeId}/memberships`,
            headers: { Cookie: alex.cookie },
          });
          assert.equal(rejoinMembers.status, 200);
          const rejoinBody = activeHomeMembershipsDtoSchema.parse(
            rejoinMembers.json(),
          );
          assert.equal(rejoinBody.currentMembershipId, membershipB);
          assert.notEqual(rejoinBody.currentMembershipId, membershipA);
          assert.equal(
            rejoinBody.memberships.some(
              (row) => row.membershipId === membershipA,
            ),
            false,
          );
          assert.ok(
            rejoinBody.memberships.some(
              (row) => row.membershipId === membershipB,
            ),
          );

          for (const path of privatePaths) {
            const res = await request({
              path,
              headers: { Cookie: alex.cookie },
            });
            assert.equal(res.status, 200, path);
          }
        });
      } finally {
        await database.pool.query(
          'DELETE FROM outbox_events WHERE home_id = $1',
          [homeId],
        );
        await database.pool.query(
          `UPDATE memberships
           SET ended_by_membership_id = id
           WHERE home_id = $1 AND ended_at IS NOT NULL`,
          [homeId],
        );
        await database.pool.query(
          `DELETE FROM memberships WHERE home_id = $1 AND ended_at IS NULL`,
          [homeId],
        );
        await database.pool.query(
          `UPDATE memberships
           SET ended_at = NULL, ended_by_membership_id = NULL
           WHERE home_id = $1`,
          [homeId],
        );
        await database.pool.query(
          'DELETE FROM memberships WHERE home_id = $1',
          [homeId],
        );
        await database.pool.query('DELETE FROM homes WHERE id = $1', [homeId]);
        if (identityIds.length > 0) {
          await database.pool.query(
            'DELETE FROM auth_identities WHERE id = ANY($1::uuid[])',
            [identityIds],
          );
          await database.pool.query(
            'DELETE FROM users WHERE id = ANY($1::uuid[])',
            [identityIds],
          );
        }
        await db.close();
        await database.close();
      }
    },
  );
});
