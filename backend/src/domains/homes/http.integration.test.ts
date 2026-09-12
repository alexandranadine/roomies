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
import type { ActiveHomeActor } from '../../platform/authz/context.js';
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
import { createHomeRepository } from './repository/home-repository.js';

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

void describe('GET /api/v1/homes/:homeId PostgreSQL authorization', () => {
  void it(
    'proves Home-scoped authorization, concealment, and cache policy',
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
      const innerResolver = createActiveHomeActorResolver(database.pool);
      let resolveCount = 0;
      const activeHomeActorResolver = {
        resolve: async (input: { userId: string; homeId: string }) => {
          resolveCount += 1;
          return innerResolver.resolve(input);
        },
      };
      const homeReader = createHomeRepository(database.pool);

      const homeAId = randomUUID();
      const homeBId = randomUUID();
      const archivedHomeId = randomUUID();
      const nonexistentHomeId = randomUUID();
      const membershipAId = randomUUID();
      const membershipBId = randomUUID();
      const membershipCId = randomUUID();
      const archivedMembershipId = randomUUID();
      const identityIds: string[] = [];
      const logs: string[] = [];
      const originalError = console.error;

      try {
        await db.connect();
        const app = createApp({
          config,
          readiness: createDbReadiness(db),
          auth,
          roomiesApi: createRoomiesApiRouter({
            principalResolver,
            activeHomeActorResolver,
            homeReader,
            archiveFinalMemberHome: () =>
              Promise.reject(new Error('archive must not run for home read')),
            changeMembershipRole: () =>
              Promise.reject(
                new Error('role change must not run for home read'),
              ),
            leaveMembership: () =>
              Promise.reject(new Error('leave must not run for home read')),
            removeMembership: () =>
              Promise.reject(new Error('remove must not run for home read')),
          }),
        });

        await withAppServer(app, async (request) => {
          async function signUp(name: string) {
            const email = `m15b-${name}-${randomUUID()}@example.test`;
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
          const userC = await signUp('UserC');

          await insertHome(database.pool, {
            id: homeAId,
            name: 'Home A',
            timezone: 'America/Los_Angeles',
          });
          await insertHome(database.pool, {
            id: homeBId,
            name: 'Home B',
            timezone: 'UTC',
          });
          await insertHome(database.pool, {
            id: archivedHomeId,
            name: 'Archived Home',
            timezone: 'UTC',
            archived: true,
          });
          await insertMembership(database.pool, {
            id: membershipAId,
            homeId: homeAId,
            userId: userA.id,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: membershipBId,
            homeId: homeBId,
            userId: userB.id,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: membershipCId,
            homeId: homeAId,
            userId: userC.id,
            role: 'ROOMMATE',
            ended: true,
          });
          await insertMembership(database.pool, {
            id: archivedMembershipId,
            homeId: archivedHomeId,
            userId: userA.id,
            role: 'ROOMMATE',
          });

          const unauthenticated = await request({
            path: `/api/v1/homes/${homeAId}`,
          });
          assert.equal(unauthenticated.status, 401);
          const unauthenticatedBody = unauthenticated.json() as ApiErrorBody;
          assert.equal(unauthenticatedBody.error.code, 'UNAUTHENTICATED');
          assert.equal(
            unauthenticated.headers.get('cache-control'),
            'private, no-store',
          );

          const beforeMalformed = resolveCount;
          const malformed = await request({
            path: '/api/v1/homes/not-a-uuid',
            headers: { Cookie: userA.cookie },
          });
          assert.equal(malformed.status, 400);
          const malformedBody = malformed.json() as ApiErrorBody;
          assert.equal(malformedBody.error.code, 'INVALID_PATH_INPUT');
          assert.equal(resolveCount, beforeMalformed);

          const roommateRead = await request({
            path: `/api/v1/homes/${homeAId}`,
            headers: { Origin: TRUSTED_ORIGIN, Cookie: userA.cookie },
          });
          assert.equal(roommateRead.status, 200);
          assert.deepEqual(roommateRead.json(), {
            id: homeAId,
            name: 'Home A',
            timezone: 'America/Los_Angeles',
          });
          assert.equal(
            roommateRead.headers.get('cache-control'),
            'private, no-store',
          );
          assert.match(
            roommateRead.headers.get(REQUEST_ID_HEADER) ?? '',
            /^[0-9a-f-]{36}$/i,
          );
          assertNoForbiddenLeak({
            context: 'ROOMMATE home read',
            text: roommateRead.text,
            forbidden: [
              ...COMMON_SECRET_SENTINELS,
              membershipAId,
              membershipBId,
              membershipCId,
              'ROOMMATE',
              'ADMIN',
              'archived',
              'ended_at',
              'joined_at',
              'membership',
              'HOME_SCOPE_MISMATCH',
              userA.email,
              PASSWORD,
            ],
          });

          const adminRead = await request({
            path: `/api/v1/homes/${homeBId}`,
            headers: { Cookie: userB.cookie },
          });
          assert.equal(adminRead.status, 200);
          assert.deepEqual(adminRead.json(), {
            id: homeBId,
            name: 'Home B',
            timezone: 'UTC',
          });
          assertNoForbiddenLeak({
            context: 'ADMIN home read',
            text: adminRead.text,
            forbidden: [membershipBId, 'ADMIN', 'ROOMMATE', 'archived'],
          });

          console.error = (...args: unknown[]) => {
            logs.push(args.map((value) => JSON.stringify(value)).join(' '));
          };

          const aReadsB = await request({
            path: `/api/v1/homes/${homeBId}`,
            headers: { Cookie: userA.cookie },
          });
          const bReadsA = await request({
            path: `/api/v1/homes/${homeAId}`,
            headers: { Cookie: userB.cookie },
          });
          const endedReadsA = await request({
            path: `/api/v1/homes/${homeAId}`,
            headers: { Cookie: userC.cookie },
          });
          const archivedRead = await request({
            path: `/api/v1/homes/${archivedHomeId}`,
            headers: { Cookie: userA.cookie },
          });
          const nonexistentRead = await request({
            path: `/api/v1/homes/${nonexistentHomeId}`,
            headers: { Cookie: userA.cookie },
          });

          const concealed = [
            aReadsB,
            bReadsA,
            endedReadsA,
            archivedRead,
            nonexistentRead,
          ];
          for (const res of concealed) {
            assert.equal(res.status, 404);
            const body = res.json() as ApiErrorBody;
            assert.deepEqual(concealedShape(body), {
              statusCode: 'NOT_FOUND',
              message: 'Not found',
            });
            assert.equal(
              body.error.requestId,
              res.headers.get(REQUEST_ID_HEADER),
            );
            assert.equal(res.headers.get('cache-control'), 'private, no-store');
            assertNoForbiddenLeak({
              context: 'concealed home read',
              text: res.text,
              forbidden: [
                ...COMMON_SECRET_SENTINELS,
                membershipAId,
                membershipBId,
                membershipCId,
                archivedMembershipId,
                'ROOMMATE',
                'ADMIN',
                'archived',
                'ended',
                'not a member',
                'membership ended',
                'home archived',
                'home exists',
                'HOME_SCOPE_MISMATCH',
                'SELECT',
                'stack',
              ],
            });
          }

          assert.deepEqual(concealedShape(aReadsB.json() as ApiErrorBody), {
            statusCode: 'NOT_FOUND',
            message: 'Not found',
          });
          assert.deepEqual(
            concealedShape(nonexistentRead.json() as ApiErrorBody),
            concealedShape(endedReadsA.json() as ApiErrorBody),
          );
          assert.deepEqual(
            concealedShape(archivedRead.json() as ApiErrorBody),
            concealedShape(nonexistentRead.json() as ApiErrorBody),
          );

          assertNoForbiddenLeak({
            context: 'authorization-denial logs',
            text: logs.join('\n'),
            forbidden: [
              homeAId,
              homeBId,
              archivedHomeId,
              nonexistentHomeId,
              membershipAId,
              'SELECT',
              ...COMMON_SECRET_SENTINELS,
            ],
          });

          const actor: ActiveHomeActor | null = await innerResolver.resolve({
            userId: userA.id,
            homeId: homeAId,
          });
          assert.ok(actor);
          assert.equal(actor.membershipId, membershipAId);
        });
      } finally {
        console.error = originalError;
        await database.pool.query(
          'DELETE FROM memberships WHERE id = ANY($1)',
          [[membershipAId, membershipBId, membershipCId, archivedMembershipId]],
        );
        await database.pool.query('DELETE FROM homes WHERE id = ANY($1)', [
          [homeAId, homeBId, archivedHomeId],
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
