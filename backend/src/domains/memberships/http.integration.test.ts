import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createChangeMembershipRoleFromPool } from '../../application/home-administration/change-membership-role.js';
import { createHomeRepository } from '../homes/index.js';
import { createRoomiesApiRouter } from '../../http/create-roomies-api.js';
import {
  createCanonicalUserLookup,
  createPrincipalResolver,
} from '../../platform/auth/principal.js';
import { createAuthRuntime } from '../../platform/auth/runtime.js';
import type { AppConfig } from '../../platform/config/types.js';
import { withAppServer } from '../../platform/http/app-request.test-helper.js';
import { REQUEST_ID_HEADER } from '../../platform/http/constants.js';
import { createApp } from '../../platform/http/create-app.js';
import type { ApiErrorBody } from '../../platform/http/errors.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import { createDbReadiness } from '../../platform/persistence/readiness.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { createDb } from '../../prisma/db.js';
import { createActiveHomeActorResolver } from './active-home-actor-resolver.js';

const TEST_SECRET = 'roomies_test_secret_32_chars_minimum_value';
const TRUSTED_ORIGIN = 'http://localhost:5173';
const PASSWORD = 'test-password-only';
const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();

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

function rolePath(homeId: string, membershipId: string): string {
  return `/api/v1/homes/${homeId}/memberships/${membershipId}/role`;
}

async function insertHome(
  pool: Pool,
  input: { id: string; name: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO homes (id, name, timezone, updated_at)
     VALUES ($1, $2, 'UTC', NOW())`,
    [input.id, input.name],
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

void describe('PATCH membership role HTTP PostgreSQL', () => {
  void it(
    'uses only a dedicated safe TEST_DATABASE_URL',
    { skip: skipWithoutDatabase },
    () => {
      const url = resolveSafeDedicatedTestDatabaseUrl();
      const parsed = parseDatabaseUrl(url);
      assert.notEqual(parsed.database.toLowerCase(), 'roomies');
      assert.match(parsed.database, /(?:^|_)(?:test|ci)$/i);
    },
  );

  void it(
    'covers success, concealment, validation, and last-Admin conflict',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const databaseUrl = resolveSafeDedicatedTestDatabaseUrl();
      const config = authConfig(databaseUrl);
      const database = createDatabasePool(config);
      const db = createDb(database.pool);
      const auth = createAuthRuntime(database.pool, config);
      const principalResolver = createPrincipalResolver({
        auth,
        hasCanonicalUser: createCanonicalUserLookup(database.pool),
      });
      const identityIds: string[] = [];
      const homeIds: string[] = [];

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
            archiveFinalMemberHome: () => Promise.resolve(),
            changeMembershipRole: createChangeMembershipRoleFromPool(
              database.pool,
            ),
            leaveMembership: () =>
              Promise.reject(new Error('leave must not run for role change')),
            removeMembership: () =>
              Promise.reject(new Error('remove must not run for role change')),
          }),
        });

        await withAppServer(app, async (request) => {
          async function signUp(name: string) {
            const email = `m21d-${name}-${randomUUID()}@example.test`;
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
            return { id, cookie: sessionCookieHeader(cookie) };
          }

          async function patchRole(input: {
            cookie: string;
            homeId: string;
            membershipId: string;
            role: string;
          }) {
            return request({
              method: 'PATCH',
              path: rolePath(input.homeId, input.membershipId),
              headers: {
                Origin: TRUSTED_ORIGIN,
                Cookie: input.cookie,
                'content-type': 'application/json',
              },
              body: JSON.stringify({ role: input.role }),
            });
          }

          const admin = await signUp('Admin');
          const roommate = await signUp('Roommate');
          const otherHomeAdmin = await signUp('OtherAdmin');
          const rejoiner = await signUp('Rejoiner');

          const homeA = randomUUID();
          const homeB = randomUUID();
          const lastAdminHome = randomUUID();
          const twoAdminHome = randomUUID();
          const rejoinHome = randomUUID();
          homeIds.push(homeA, homeB, lastAdminHome, twoAdminHome, rejoinHome);

          const membershipAdminA = randomUUID();
          const membershipRoommateA = randomUUID();
          const membershipAdminB = randomUUID();
          const lastAdminMembership = randomUUID();
          const lastRoommateMembership = randomUUID();
          const twoAdminA = randomUUID();
          const twoAdminB = randomUUID();
          const rejoinAdmin = randomUUID();
          const rejoinOld = randomUUID();
          const rejoinNew = randomUUID();
          const endedInA = randomUUID();

          await insertHome(database.pool, { id: homeA, name: 'Home A' });
          await insertHome(database.pool, { id: homeB, name: 'Home B' });
          await insertHome(database.pool, {
            id: lastAdminHome,
            name: 'Last Admin Home',
          });
          await insertHome(database.pool, {
            id: twoAdminHome,
            name: 'Two Admin Home',
          });
          await insertHome(database.pool, { id: rejoinHome, name: 'Rejoin' });

          await insertMembership(database.pool, {
            id: membershipAdminA,
            homeId: homeA,
            userId: admin.id,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: membershipRoommateA,
            homeId: homeA,
            userId: roommate.id,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: endedInA,
            homeId: homeA,
            userId: otherHomeAdmin.id,
            role: 'ROOMMATE',
            ended: true,
          });
          await insertMembership(database.pool, {
            id: membershipAdminB,
            homeId: homeB,
            userId: otherHomeAdmin.id,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: lastAdminMembership,
            homeId: lastAdminHome,
            userId: admin.id,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: lastRoommateMembership,
            homeId: lastAdminHome,
            userId: roommate.id,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: twoAdminA,
            homeId: twoAdminHome,
            userId: admin.id,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: twoAdminB,
            homeId: twoAdminHome,
            userId: otherHomeAdmin.id,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: rejoinAdmin,
            homeId: rejoinHome,
            userId: admin.id,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: rejoinOld,
            homeId: rejoinHome,
            userId: rejoiner.id,
            role: 'ROOMMATE',
            ended: true,
          });
          await insertMembership(database.pool, {
            id: rejoinNew,
            homeId: rejoinHome,
            userId: rejoiner.id,
            role: 'ROOMMATE',
          });

          const unauthenticated = await request({
            method: 'PATCH',
            path: rolePath(homeA, membershipRoommateA),
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ role: 'ADMIN' }),
          });
          assert.equal(unauthenticated.status, 401);
          assert.equal(
            (unauthenticated.json() as ApiErrorBody).error.code,
            'UNAUTHENTICATED',
          );
          assert.equal(
            unauthenticated.headers.get('cache-control'),
            'private, no-store',
          );

          const malformedHome = await patchRole({
            cookie: admin.cookie,
            homeId: 'not-a-uuid',
            membershipId: membershipRoommateA,
            role: 'ADMIN',
          });
          assert.equal(malformedHome.status, 400);
          assert.equal(
            (malformedHome.json() as ApiErrorBody).error.code,
            'INVALID_PATH_INPUT',
          );

          const malformedMembership = await patchRole({
            cookie: admin.cookie,
            homeId: homeA,
            membershipId: 'nope',
            role: 'ADMIN',
          });
          assert.equal(malformedMembership.status, 400);
          assert.equal(
            (malformedMembership.json() as ApiErrorBody).error.code,
            'INVALID_PATH_INPUT',
          );

          const invalidRole = await patchRole({
            cookie: admin.cookie,
            homeId: homeA,
            membershipId: membershipRoommateA,
            role: 'SUPERADMIN',
          });
          assert.equal(invalidRole.status, 400);
          assert.equal(
            (invalidRole.json() as ApiErrorBody).error.code,
            'INVALID_REQUEST',
          );

          const promote = await patchRole({
            cookie: admin.cookie,
            homeId: homeA,
            membershipId: membershipRoommateA,
            role: 'ADMIN',
          });
          assert.equal(promote.status, 204);
          assert.equal(promote.text, '');
          assert.equal(
            promote.headers.get('cache-control'),
            'private, no-store',
          );
          assert.match(
            promote.headers.get(REQUEST_ID_HEADER) ?? '',
            /^[0-9a-f-]{36}$/i,
          );

          const demoteAllowed = await patchRole({
            cookie: admin.cookie,
            homeId: homeA,
            membershipId: membershipRoommateA,
            role: 'ROOMMATE',
          });
          assert.equal(demoteAllowed.status, 204);
          assert.equal(demoteAllowed.text, '');

          const sameRole = await patchRole({
            cookie: admin.cookie,
            homeId: homeA,
            membershipId: membershipRoommateA,
            role: 'ROOMMATE',
          });
          assert.equal(sameRole.status, 204);
          const sameRoleEvents = await database.pool.query<{
            event_id: string;
          }>(
            `SELECT event_id FROM outbox_events
             WHERE home_id = $1 AND payload->>'membershipId' = $2
               AND payload->>'previousRole' = 'ROOMMATE'
               AND payload->>'newRole' = 'ROOMMATE'`,
            [homeA, membershipRoommateA],
          );
          assert.equal(sameRoleEvents.rows.length, 0);

          const roommateAttempt = await patchRole({
            cookie: roommate.cookie,
            homeId: homeA,
            membershipId: membershipAdminA,
            role: 'ROOMMATE',
          });
          assert.equal(roommateAttempt.status, 403);
          assert.equal(
            (roommateAttempt.json() as ApiErrorBody).error.code,
            'FORBIDDEN',
          );

          const lastAdmin = await patchRole({
            cookie: admin.cookie,
            homeId: lastAdminHome,
            membershipId: lastAdminMembership,
            role: 'ROOMMATE',
          });
          assert.equal(lastAdmin.status, 409);
          assert.equal(
            (lastAdmin.json() as ApiErrorBody).error.code,
            'LAST_ADMIN_REQUIRED',
          );

          const selfDemote = await patchRole({
            cookie: admin.cookie,
            homeId: twoAdminHome,
            membershipId: twoAdminA,
            role: 'ROOMMATE',
          });
          assert.equal(selfDemote.status, 204);

          const nonexistent = await patchRole({
            cookie: admin.cookie,
            homeId: homeA,
            membershipId: randomUUID(),
            role: 'ADMIN',
          });
          assert.equal(nonexistent.status, 404);
          assert.equal(
            (nonexistent.json() as ApiErrorBody).error.code,
            'NOT_FOUND',
          );
          assert.equal(
            (nonexistent.json() as ApiErrorBody).error.message,
            'Not found',
          );

          const ended = await patchRole({
            cookie: admin.cookie,
            homeId: homeA,
            membershipId: endedInA,
            role: 'ADMIN',
          });
          assert.equal(ended.status, 404);

          const crossHome = await patchRole({
            cookie: admin.cookie,
            homeId: homeA,
            membershipId: membershipAdminB,
            role: 'ROOMMATE',
          });
          assert.equal(crossHome.status, 404);
          assert.equal(
            (crossHome.json() as ApiErrorBody).error.message,
            'Not found',
          );

          const oldTenure = await patchRole({
            cookie: admin.cookie,
            homeId: rejoinHome,
            membershipId: rejoinOld,
            role: 'ADMIN',
          });
          assert.equal(oldTenure.status, 404);
          const newTenure = await database.pool.query<{ role: string }>(
            'SELECT role FROM memberships WHERE id = $1',
            [rejoinNew],
          );
          assert.equal(newTenure.rows[0]?.role, 'ROOMMATE');
        });
      } finally {
        await database.pool.query(
          'DELETE FROM outbox_events WHERE home_id = ANY($1::uuid[])',
          [homeIds],
        );
        await database.pool.query(
          'DELETE FROM memberships WHERE home_id = ANY($1::uuid[])',
          [homeIds],
        );
        await database.pool.query(
          'DELETE FROM homes WHERE id = ANY($1::uuid[])',
          [homeIds],
        );
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
