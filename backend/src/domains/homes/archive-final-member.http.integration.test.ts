import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createArchiveFinalMemberHomeFromPool } from '../../application/home-administration/archive-final-member-home.js';
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
import { createActiveHomeActorResolver } from '../memberships/active-home-actor-resolver.js';
import { createHomeRepository } from './repository/home-repository.js';

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

function archivePath(homeId: string): string {
  return `/api/v1/homes/${homeId}/archive-final-member`;
}

async function insertHome(
  pool: Pool,
  input: { id: string; name: string; archived?: boolean },
): Promise<void> {
  await pool.query(
    `INSERT INTO homes (id, name, timezone, archived_at, updated_at)
     VALUES ($1, $2, 'UTC', $3, NOW())`,
    [input.id, input.name, input.archived === true ? new Date() : null],
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

void describe('POST archive final member HTTP PostgreSQL', () => {
  void it(
    'uses only a dedicated safe TEST_DATABASE_URL',
    { skip: skipWithoutDatabase },
    () => {
      const parsed = parseDatabaseUrl(resolveSafeDedicatedTestDatabaseUrl());
      assert.notEqual(parsed.database.toLowerCase(), 'roomies');
      assert.match(parsed.database, /(?:^|_)(?:test|ci)$/i);
    },
  );

  void it(
    'covers success, authorization, concealment, conflicts, and validation',
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
            archiveFinalMemberHome: createArchiveFinalMemberHomeFromPool(
              database.pool,
            ),
            changeMembershipRole: () =>
              Promise.reject(new Error('role change must not run for archive')),
            leaveMembership: () =>
              Promise.reject(new Error('leave must not run for archive')),
            removeMembership: () =>
              Promise.reject(new Error('remove must not run for archive')),
          }),
        });

        await withAppServer(app, async (request) => {
          async function signUp(name: string) {
            const email = `archive-http-${name}-${randomUUID()}@example.test`;
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

          async function postArchive(input: {
            homeId: string;
            cookie?: string;
            body?: unknown;
            rawBody?: string;
          }) {
            const headers: Record<string, string> = {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            };
            if (input.cookie !== undefined) {
              headers.Cookie = input.cookie;
            }
            return request({
              method: 'POST',
              path: archivePath(input.homeId),
              headers,
              body:
                input.rawBody ??
                JSON.stringify(input.body === undefined ? {} : input.body),
            });
          }

          const soleAdmin = await signUp('SoleAdmin');
          const multiAdmin = await signUp('MultiAdmin');
          const multiPeer = await signUp('MultiPeer');
          const roommate = await signUp('Roommate');
          const roommateHomeAdmin = await signUp('RoommateHomeAdmin');
          const archivedAdmin = await signUp('ArchivedAdmin');
          const inactiveActor = await signUp('InactiveActor');
          const inactiveHomeAdmin = await signUp('InactiveHomeAdmin');

          const soleHome = randomUUID();
          const multiAdminHome = randomUUID();
          const roommateHome = randomUUID();
          const archivedHome = randomUUID();
          const inactiveHome = randomUUID();
          homeIds.push(
            soleHome,
            multiAdminHome,
            roommateHome,
            archivedHome,
            inactiveHome,
          );

          await insertHome(database.pool, {
            id: soleHome,
            name: 'Sole Admin Home',
          });
          await insertHome(database.pool, {
            id: multiAdminHome,
            name: 'Multi Admin Home',
          });
          await insertHome(database.pool, {
            id: roommateHome,
            name: 'Roommate Home',
          });
          await insertHome(database.pool, {
            id: archivedHome,
            name: 'Archived Home',
            archived: true,
          });
          await insertHome(database.pool, {
            id: inactiveHome,
            name: 'Inactive Actor Home',
          });

          await insertMembership(database.pool, {
            id: randomUUID(),
            homeId: soleHome,
            userId: soleAdmin.id,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: randomUUID(),
            homeId: multiAdminHome,
            userId: multiAdmin.id,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: randomUUID(),
            homeId: multiAdminHome,
            userId: multiPeer.id,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: randomUUID(),
            homeId: roommateHome,
            userId: roommate.id,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: randomUUID(),
            homeId: roommateHome,
            userId: roommateHomeAdmin.id,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: randomUUID(),
            homeId: archivedHome,
            userId: archivedAdmin.id,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: randomUUID(),
            homeId: inactiveHome,
            userId: inactiveActor.id,
            role: 'ROOMMATE',
            ended: true,
          });
          await insertMembership(database.pool, {
            id: randomUUID(),
            homeId: inactiveHome,
            userId: inactiveHomeAdmin.id,
            role: 'ADMIN',
          });

          const unauthenticated = await postArchive({ homeId: soleHome });
          assert.equal(unauthenticated.status, 401);
          assert.equal(
            (unauthenticated.json() as ApiErrorBody).error.code,
            'UNAUTHENTICATED',
          );

          const malformedHomeId = await postArchive({
            homeId: 'not-a-uuid',
            cookie: soleAdmin.cookie,
          });
          assert.equal(malformedHomeId.status, 400);
          assert.equal(
            (malformedHomeId.json() as ApiErrorBody).error.code,
            'INVALID_PATH_INPUT',
          );

          for (const [body, expectedCode] of [
            [null, 'INVALID_REQUEST'],
            [[], 'INVALID_REQUEST'],
            [{ extra: true }, 'INVALID_REQUEST'],
          ] as const) {
            const response = await postArchive({
              homeId: multiAdminHome,
              cookie: multiAdmin.cookie,
              body,
            });
            assert.equal(response.status, 400);
            assert.equal(
              (response.json() as ApiErrorBody).error.code,
              expectedCode,
            );
          }

          const malformedJson = await postArchive({
            homeId: multiAdminHome,
            cookie: multiAdmin.cookie,
            rawBody: '{not-json',
          });
          assert.equal(malformedJson.status, 400);
          assert.equal(
            (malformedJson.json() as ApiErrorBody).error.code,
            'BAD_REQUEST',
          );

          const multiMemberAdmin = await postArchive({
            homeId: multiAdminHome,
            cookie: multiAdmin.cookie,
          });
          assert.equal(multiMemberAdmin.status, 409);
          assert.equal(
            (multiMemberAdmin.json() as ApiErrorBody).error.code,
            'FINAL_MEMBER_REQUIRED',
          );

          const multiMemberRoommate = await postArchive({
            homeId: roommateHome,
            cookie: roommate.cookie,
          });
          assert.equal(multiMemberRoommate.status, 403);
          assert.equal(
            (multiMemberRoommate.json() as ApiErrorBody).error.code,
            'FORBIDDEN',
          );

          const archived = await postArchive({
            homeId: archivedHome,
            cookie: archivedAdmin.cookie,
          });
          assert.equal(archived.status, 404);
          assert.equal(
            (archived.json() as ApiErrorBody).error.code,
            'NOT_FOUND',
          );

          const inactive = await postArchive({
            homeId: inactiveHome,
            cookie: inactiveActor.cookie,
          });
          assert.equal(inactive.status, 404);
          assert.equal(
            (inactive.json() as ApiErrorBody).error.code,
            'NOT_FOUND',
          );

          const success = await postArchive({
            homeId: soleHome,
            cookie: soleAdmin.cookie,
          });
          assert.equal(success.status, 204);
          assert.equal(success.text, '');
          assert.equal(
            success.headers.get('cache-control'),
            'private, no-store',
          );
          assert.match(
            success.headers.get(REQUEST_ID_HEADER) ?? '',
            /^[0-9a-f-]{36}$/i,
          );
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
