import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createRoomiesApiRouter } from '../../http/create-roomies-api.js';
import {
  createCanonicalUserLookup,
  createPrincipalResolver,
} from '../../platform/auth/principal.js';
import { createAuthRuntime } from '../../platform/auth/runtime.js';
import type { AppConfig } from '../../platform/config/types.js';
import { withAppServer } from '../../platform/http/app-request.test-helper.js';
import {
  assertNoForbiddenLeak,
  COMMON_SECRET_SENTINELS,
} from '../../platform/http/assert-no-forbidden-leak.js';
import { REQUEST_ID_HEADER } from '../../platform/http/constants.js';
import { createApp } from '../../platform/http/create-app.js';
import type { ApiErrorBody } from '../../platform/http/errors.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import { createDbReadiness } from '../../platform/persistence/readiness.js';
import { resolveTestDatabaseUrl } from '../../platform/persistence/test-database.js';
import { createDb } from '../../prisma/db.js';
import { createActiveHomeActorResolver } from '../memberships/active-home-actor-resolver.js';
import { listActiveHomesForUser } from './list-active-homes.js';
import { createActiveHomesForUserReader } from './repository/active-homes-for-user.js';
import { createHomeRepository } from './repository/home-repository.js';

const TEST_SECRET = 'roomies_test_secret_32_chars_minimum_value';
const TRUSTED_ORIGIN = 'http://localhost:5173';
const HOSTILE_ORIGIN = 'https://evil.example';
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
    frontendOrigin: 'http://localhost:5173',
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

async function insertHome(
  pool: Pool,
  input: { id: string; name: string; timezone: string; archived?: boolean },
): Promise<void> {
  await pool.query(
    `INSERT INTO homes (id, name, timezone, archived_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [
      input.id,
      input.name,
      input.timezone,
      input.archived === true ? new Date() : null,
    ],
  );
}

async function insertMembership(
  pool: Pool,
  input: {
    id: string;
    homeId: string;
    userId: string;
    role: 'ROOMMATE' | 'ADMIN';
    ended?: boolean;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO memberships (id, home_id, user_id, role, ended_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      input.id,
      input.homeId,
      input.userId,
      input.role,
      input.ended === true ? new Date() : null,
    ],
  );
}

function concealedShape(body: ApiErrorBody): {
  statusCode: string;
  message: string;
} {
  return { statusCode: body.error.code, message: body.error.message };
}

void describe('GET /api/v1/me/homes HTTP integration', () => {
  void it(
    'lists current Homes and conceals inaccessible Home context',
    { skip: skipWithoutDatabase },
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
      const activeHomesForUserReader = createActiveHomesForUserReader(
        database.pool,
      );
      const homeAId = randomUUID();
      const homeBId = randomUUID();
      const archivedHomeId = randomUUID();
      const inaccessibleHomeId = randomUUID();
      const membershipAId = randomUUID();
      const membershipBId = randomUUID();
      const endedMembershipId = randomUUID();
      const archivedMembershipId = randomUUID();
      const otherMembershipId = randomUUID();
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
            listActiveHomes: (input) =>
              listActiveHomesForUser(input, activeHomesForUserReader),
            archiveFinalMemberHome: () =>
              Promise.reject(new Error('archive must not run for discovery')),
            changeMembershipRole: () =>
              Promise.reject(
                new Error('role change must not run for discovery'),
              ),
            leaveMembership: () =>
              Promise.reject(new Error('leave must not run for discovery')),
            removeMembership: () =>
              Promise.reject(new Error('remove must not run for discovery')),
          }),
        });

        await withAppServer(app, async (request) => {
          async function signUp(name: string) {
            const email = `m23b-${name}-${randomUUID()}@example.test`;
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
            const cookie = findSessionSetCookie(signup.headers);
            assert.ok(cookie);
            return { id, cookie: sessionCookieHeader(cookie), email };
          }

          const userA = await signUp('UserA');
          const userB = await signUp('UserB');

          const unauthenticated = await request({ path: '/api/v1/me/homes' });
          assert.equal(unauthenticated.status, 401);
          const unauthenticatedBody = unauthenticated.json() as ApiErrorBody;
          assert.equal(unauthenticatedBody.error.code, 'UNAUTHENTICATED');
          assert.equal(
            unauthenticated.headers.get('cache-control'),
            'private, no-store',
          );

          const zeroHomes = await request({
            path: '/api/v1/me/homes',
            headers: { Cookie: userA.cookie },
          });
          assert.equal(zeroHomes.status, 200);
          assert.deepEqual(zeroHomes.json(), []);
          assert.equal(
            zeroHomes.headers.get('cache-control'),
            'private, no-store',
          );

          await insertHome(database.pool, {
            id: homeAId,
            name: 'Cedar House',
            timezone: 'UTC',
          });
          await insertHome(database.pool, {
            id: homeBId,
            name: 'Oak Street',
            timezone: 'America/Los_Angeles',
          });
          await insertHome(database.pool, {
            id: archivedHomeId,
            name: 'Archived Place',
            timezone: 'UTC',
            archived: true,
          });
          await insertHome(database.pool, {
            id: inaccessibleHomeId,
            name: 'Private Home',
            timezone: 'UTC',
          });
          await insertMembership(database.pool, {
            id: membershipAId,
            homeId: homeAId,
            userId: userA.id,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: membershipBId,
            homeId: homeBId,
            userId: userA.id,
            role: 'ROOMMATE',
            ended: true,
          });
          await insertMembership(database.pool, {
            id: endedMembershipId,
            homeId: inaccessibleHomeId,
            userId: userA.id,
            role: 'ROOMMATE',
            ended: true,
          });
          await insertMembership(database.pool, {
            id: archivedMembershipId,
            homeId: archivedHomeId,
            userId: userA.id,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: otherMembershipId,
            homeId: inaccessibleHomeId,
            userId: userB.id,
            role: 'ADMIN',
          });

          const missingOrigin = await request({
            path: '/api/v1/me/homes',
            headers: { Cookie: userA.cookie },
          });
          assert.equal(missingOrigin.status, 200);
          assert.deepEqual(missingOrigin.json(), [
            {
              id: homeAId,
              name: 'Cedar House',
              timezone: 'UTC',
              role: 'ADMIN',
            },
          ]);
          assert.match(
            missingOrigin.headers.get(REQUEST_ID_HEADER) ?? '',
            /^[0-9a-f-]{36}$/i,
          );
          assertNoForbiddenLeak({
            context: 'discovery success body',
            text: missingOrigin.text,
            forbidden: [
              ...COMMON_SECRET_SENTINELS,
              membershipAId,
              membershipBId,
              endedMembershipId,
              archivedMembershipId,
              otherMembershipId,
              homeBId,
              archivedHomeId,
              inaccessibleHomeId,
              userB.id,
              userA.email,
              PASSWORD,
              TEST_SECRET,
              'ended_at',
              'joined_at',
              'archived',
              'invitation',
              'membershipId',
            ],
          });

          const hostileOrigin = await request({
            path: '/api/v1/me/homes',
            headers: { Origin: HOSTILE_ORIGIN, Cookie: userA.cookie },
          });
          assert.equal(hostileOrigin.status, 200);
          assert.deepEqual(hostileOrigin.json(), missingOrigin.json());

          await insertMembership(database.pool, {
            id: randomUUID(),
            homeId: homeBId,
            userId: userA.id,
            role: 'ROOMMATE',
          });

          const activeOnly = await request({
            path: `/api/v1/me/homes?userId=${userB.id}`,
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: userA.cookie,
              'x-user-id': userB.id,
            },
          });
          assert.equal(activeOnly.status, 200);
          assert.deepEqual(activeOnly.json(), [
            {
              id: homeAId,
              name: 'Cedar House',
              timezone: 'UTC',
              role: 'ADMIN',
            },
            {
              id: homeBId,
              name: 'Oak Street',
              timezone: 'America/Los_Angeles',
              role: 'ROOMMATE',
            },
          ]);
          assert.equal(activeOnly.text.includes(userB.id), false);

          const otherUserList = await request({
            path: '/api/v1/me/homes',
            headers: { Cookie: userB.cookie },
          });
          assert.equal(otherUserList.status, 200);
          assert.deepEqual(otherUserList.json(), [
            {
              id: inaccessibleHomeId,
              name: 'Private Home',
              timezone: 'UTC',
              role: 'ADMIN',
            },
          ]);
          assert.equal(otherUserList.text.includes(homeAId), false);
          assert.equal(otherUserList.text.includes(membershipAId), false);

          const inaccessibleContext = await request({
            path: `/api/v1/homes/${inaccessibleHomeId}`,
            headers: { Cookie: userA.cookie },
          });
          assert.equal(inaccessibleContext.status, 404);
          const inaccessibleBody = inaccessibleContext.json() as ApiErrorBody;
          assert.equal(inaccessibleBody.error.code, 'NOT_FOUND');
          assert.equal(inaccessibleBody.error.message, 'Not found');
          assertNoForbiddenLeak({
            context: 'inaccessible Home context',
            text: inaccessibleContext.text,
            forbidden: [
              ...COMMON_SECRET_SENTINELS,
              inaccessibleHomeId,
              membershipAId,
              endedMembershipId,
              'ROOMMATE',
              'ADMIN',
              'archived',
              'ended_at',
            ],
          });

          const archivedContext = await request({
            path: `/api/v1/homes/${archivedHomeId}`,
            headers: { Cookie: userA.cookie },
          });
          assert.equal(archivedContext.status, 404);
          assert.deepEqual(
            concealedShape(archivedContext.json() as ApiErrorBody),
            concealedShape(inaccessibleBody),
          );
          assertNoForbiddenLeak({
            context: 'archived Home context',
            text: archivedContext.text,
            forbidden: [
              ...COMMON_SECRET_SENTINELS,
              archivedHomeId,
              archivedMembershipId,
              'archived',
              'ADMIN',
              'ROOMMATE',
            ],
          });

          const authorizedContext = await request({
            path: `/api/v1/homes/${homeAId}`,
            headers: { Cookie: userA.cookie },
          });
          assert.equal(authorizedContext.status, 200);
          assert.deepEqual(authorizedContext.json(), {
            id: homeAId,
            name: 'Cedar House',
            timezone: 'UTC',
          });
        });
      } finally {
        await database.pool.query(
          'DELETE FROM memberships WHERE home_id = ANY($1)',
          [[homeAId, homeBId, archivedHomeId, inaccessibleHomeId]],
        );
        await database.pool.query('DELETE FROM homes WHERE id = ANY($1)', [
          [homeAId, homeBId, archivedHomeId, inaccessibleHomeId],
        ]);
        for (const id of identityIds) {
          await database.pool.query(
            'DELETE FROM auth_identities WHERE id = $1',
            [id],
          );
          await database.pool.query('DELETE FROM users WHERE id = $1', [id]);
        }
        await db.close();
        await database.close();
      }
    },
  );
});
