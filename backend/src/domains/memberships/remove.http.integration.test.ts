import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createChangeMembershipRoleFromPool } from '../../application/home-administration/change-membership-role.js';
import { createLeaveMembershipFromPool } from '../../application/home-administration/leave-membership.js';
import { createRemoveMembershipFromPool } from '../../application/home-administration/remove-membership.js';
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

function removePath(homeId: string, membershipId: string): string {
  return `/api/v1/homes/${homeId}/memberships/${membershipId}/remove`;
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

void describe('POST membership remove HTTP PostgreSQL', () => {
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
    'covers success, concealment, authorization, validation, and self-remove',
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
            leaveMembership: createLeaveMembershipFromPool(database.pool),
            removeMembership: createRemoveMembershipFromPool(database.pool),
          }),
        });

        await withAppServer(app, async (request) => {
          async function signUp(name: string) {
            const email = `m21g-${name}-${randomUUID()}@example.test`;
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

          async function postRemove(input: {
            cookie: string;
            homeId: string;
            membershipId: string;
            body?: unknown;
            rawBody?: string;
          }) {
            return request({
              method: 'POST',
              path: removePath(input.homeId, input.membershipId),
              headers: {
                Origin: TRUSTED_ORIGIN,
                Cookie: input.cookie,
                'content-type': 'application/json',
              },
              body:
                input.rawBody ??
                JSON.stringify(input.body === undefined ? {} : input.body),
            });
          }

          const admin = await signUp('Admin');
          const roommate = await signUp('Roommate');
          const peerAdmin = await signUp('PeerAdmin');
          const otherHomeAdmin = await signUp('OtherAdmin');
          const rejoiner = await signUp('Rejoiner');
          const roommateTarget = await signUp('RoommateTarget');

          const homeA = randomUUID();
          const homeB = randomUUID();
          const twoAdminHome = randomUUID();
          const rejoinHome = randomUUID();
          const roommateDenyHome = randomUUID();
          homeIds.push(
            homeA,
            homeB,
            twoAdminHome,
            rejoinHome,
            roommateDenyHome,
          );

          const membershipAdminA = randomUUID();
          const membershipRoommateA = randomUUID();
          const membershipAdminB = randomUUID();
          const twoAdminA = randomUUID();
          const twoAdminB = randomUUID();
          const rejoinAdmin = randomUUID();
          const rejoinOld = randomUUID();
          const rejoinNew = randomUUID();
          const endedInA = randomUUID();
          const roommateDenyAdmin = randomUUID();
          const roommateDenyRoommate = randomUUID();

          await insertHome(database.pool, { id: homeA, name: 'Home A' });
          await insertHome(database.pool, { id: homeB, name: 'Home B' });
          await insertHome(database.pool, {
            id: twoAdminHome,
            name: 'Two Admin Home',
          });
          await insertHome(database.pool, { id: rejoinHome, name: 'Rejoin' });
          await insertHome(database.pool, {
            id: roommateDenyHome,
            name: 'Roommate Deny',
          });

          await insertMembership(database.pool, {
            id: membershipAdminA,
            homeId: homeA,
            userId: admin.id,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: membershipRoommateA,
            homeId: homeA,
            userId: roommateTarget.id,
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
            id: twoAdminA,
            homeId: twoAdminHome,
            userId: admin.id,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: twoAdminB,
            homeId: twoAdminHome,
            userId: peerAdmin.id,
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
          await insertMembership(database.pool, {
            id: roommateDenyAdmin,
            homeId: roommateDenyHome,
            userId: admin.id,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: roommateDenyRoommate,
            homeId: roommateDenyHome,
            userId: roommate.id,
            role: 'ROOMMATE',
          });

          const unauthenticated = await request({
            method: 'POST',
            path: removePath(homeA, membershipRoommateA),
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
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

          const malformedHome = await postRemove({
            cookie: admin.cookie,
            homeId: 'not-a-uuid',
            membershipId: membershipRoommateA,
          });
          assert.equal(malformedHome.status, 400);
          assert.equal(
            (malformedHome.json() as ApiErrorBody).error.code,
            'INVALID_PATH_INPUT',
          );

          const malformedMembership = await postRemove({
            cookie: admin.cookie,
            homeId: homeA,
            membershipId: 'nope',
          });
          assert.equal(malformedMembership.status, 400);
          assert.equal(
            (malformedMembership.json() as ApiErrorBody).error.code,
            'INVALID_PATH_INPUT',
          );

          const nullBody = await postRemove({
            cookie: admin.cookie,
            homeId: homeA,
            membershipId: membershipRoommateA,
            body: null,
          });
          assert.equal(nullBody.status, 400);
          assert.equal(
            (nullBody.json() as ApiErrorBody).error.code,
            'INVALID_REQUEST',
          );

          const arrayBody = await postRemove({
            cookie: admin.cookie,
            homeId: homeA,
            membershipId: membershipRoommateA,
            body: [],
          });
          assert.equal(arrayBody.status, 400);
          assert.equal(
            (arrayBody.json() as ApiErrorBody).error.code,
            'INVALID_REQUEST',
          );

          const extraFieldBody = await postRemove({
            cookie: admin.cookie,
            homeId: homeA,
            membershipId: membershipRoommateA,
            body: { anything: true },
          });
          assert.equal(extraFieldBody.status, 400);
          assert.equal(
            (extraFieldBody.json() as ApiErrorBody).error.code,
            'INVALID_REQUEST',
          );

          const malformedJson = await postRemove({
            cookie: admin.cookie,
            homeId: homeA,
            membershipId: membershipRoommateA,
            rawBody: '{not-json',
          });
          assert.equal(malformedJson.status, 400);
          assert.equal(
            (malformedJson.json() as ApiErrorBody).error.code,
            'BAD_REQUEST',
          );

          const roommateAttempt = await postRemove({
            cookie: roommate.cookie,
            homeId: roommateDenyHome,
            membershipId: roommateDenyAdmin,
          });
          assert.equal(roommateAttempt.status, 403);
          assert.equal(
            (roommateAttempt.json() as ApiErrorBody).error.code,
            'FORBIDDEN',
          );

          const selfRemove = await postRemove({
            cookie: admin.cookie,
            homeId: twoAdminHome,
            membershipId: twoAdminA,
          });
          assert.equal(selfRemove.status, 403);
          assert.equal(
            (selfRemove.json() as ApiErrorBody).error.code,
            'FORBIDDEN',
          );
          assert.notEqual(
            (selfRemove.json() as ApiErrorBody).error.code,
            'LAST_ROOMMATE_REQUIRES_ARCHIVE',
          );

          const missingTarget = await postRemove({
            cookie: admin.cookie,
            homeId: homeA,
            membershipId: randomUUID(),
          });
          assert.equal(missingTarget.status, 404);
          assert.equal(
            (missingTarget.json() as ApiErrorBody).error.code,
            'NOT_FOUND',
          );

          const ended = await postRemove({
            cookie: admin.cookie,
            homeId: homeA,
            membershipId: endedInA,
          });
          assert.equal(ended.status, 404);

          const crossHome = await postRemove({
            cookie: admin.cookie,
            homeId: homeA,
            membershipId: membershipAdminB,
          });
          assert.equal(crossHome.status, 404);
          assert.equal(
            (crossHome.json() as ApiErrorBody).error.message,
            'Not found',
          );

          const oldTenure = await postRemove({
            cookie: admin.cookie,
            homeId: rejoinHome,
            membershipId: rejoinOld,
          });
          assert.equal(oldTenure.status, 404);
          const newTenureBefore = await database.pool.query<{
            ended_at: Date | null;
          }>('SELECT ended_at FROM memberships WHERE id = $1', [rejoinNew]);
          assert.equal(newTenureBefore.rows[0]?.ended_at, null);

          const adminRemovesRoommate = await postRemove({
            cookie: admin.cookie,
            homeId: homeA,
            membershipId: membershipRoommateA,
            body: {},
          });
          assert.equal(adminRemovesRoommate.status, 204);
          assert.equal(adminRemovesRoommate.text, '');
          assert.equal(
            adminRemovesRoommate.headers.get('cache-control'),
            'private, no-store',
          );
          assert.match(
            adminRemovesRoommate.headers.get(REQUEST_ID_HEADER) ?? '',
            /^[0-9a-f-]{36}$/i,
          );

          const adminRemovesAdmin = await postRemove({
            cookie: admin.cookie,
            homeId: twoAdminHome,
            membershipId: twoAdminB,
          });
          assert.equal(adminRemovesAdmin.status, 204);
          assert.equal(adminRemovesAdmin.text, '');
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
