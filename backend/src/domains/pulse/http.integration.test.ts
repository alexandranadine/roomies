import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createGetHousePulseFromPool } from '../../application/pulse/get-house-pulse.js';
import { createHomeRepository } from '../homes/index.js';
import { createRoomiesApiRouter } from '../../http/create-roomies-api.js';
import { createActiveHomeActorResolver } from '../memberships/index.js';
import {
  createCanonicalUserLookup,
  createPrincipalResolver,
} from '../../platform/auth/principal.js';
import { createAuthRuntime } from '../../platform/auth/runtime.js';
import type { AppConfig } from '../../platform/config/types.js';
import { withAppServer } from '../../platform/http/app-request.test-helper.js';
import { createApp } from '../../platform/http/create-app.js';
import type { ApiErrorBody } from '../../platform/http/errors.js';
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import { createDbReadiness } from '../../platform/persistence/readiness.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { createDb } from '../../prisma/db.js';
import { housePulseDtoSchema } from './house-pulse-dto.js';

const TEST_SECRET = 'roomies_test_secret_32_chars_minimum_value';
const TRUSTED_ORIGIN = 'http://127.0.0.1:5173';
const CANONICAL_FRONTEND_ORIGIN = 'http://localhost:5173';
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
    frontendOrigin: CANONICAL_FRONTEND_ORIGIN,
    trustedOrigins: [TRUSTED_ORIGIN, CANONICAL_FRONTEND_ORIGIN],
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
    `INSERT INTO memberships (id, home_id, user_id, role, ended_at, ended_by_membership_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.id,
      input.homeId,
      input.userId,
      input.role,
      input.ended === true ? new Date() : null,
      input.ended === true ? input.id : null,
    ],
  );
}

void describe('House Pulse HTTP PostgreSQL', () => {
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
    'authorizes Pulse with concealed 404s and private/no-store headers',
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
            changeMembershipRole: () =>
              Promise.reject(new Error('role change must not run')),
            leaveMembership: () =>
              Promise.reject(new Error('leave must not run')),
            removeMembership: () =>
              Promise.reject(new Error('remove must not run')),
            pulse: {
              getHousePulse: createGetHousePulseFromPool(database.pool),
            },
          }),
        });

        await withAppServer(app, async (request) => {
          async function signUp(name: string) {
            const email = `m75-pulse-${name}-${randomUUID()}@example.test`;
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

          const roommate = await signUp('roommate');
          const admin = await signUp('admin');
          const outsider = await signUp('outsider');

          const homeA = createUuidV7();
          const homeB = createUuidV7();
          const archivedHome = createUuidV7();
          homeIds.push(homeA, homeB, archivedHome);
          await insertHome(database.pool, { id: homeA, name: 'Pulse A' });
          await insertHome(database.pool, { id: homeB, name: 'Pulse B' });
          await insertHome(database.pool, {
            id: archivedHome,
            name: 'Archived',
            archived: true,
          });
          await insertMembership(database.pool, {
            id: createUuidV7(),
            homeId: homeA,
            userId: roommate.id,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: createUuidV7(),
            homeId: homeA,
            userId: admin.id,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: createUuidV7(),
            homeId: homeB,
            userId: outsider.id,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: createUuidV7(),
            homeId: archivedHome,
            userId: roommate.id,
            role: 'ROOMMATE',
          });
          const staleMembership = createUuidV7();
          await insertMembership(database.pool, {
            id: staleMembership,
            homeId: homeB,
            userId: roommate.id,
            role: 'ROOMMATE',
            ended: true,
          });

          const unauthenticated = await request({
            method: 'GET',
            path: `/api/v1/homes/${homeA}/pulse`,
            headers: { Origin: TRUSTED_ORIGIN },
          });
          assert.equal(unauthenticated.status, 401);

          const roommateRes = await request({
            method: 'GET',
            path: `/api/v1/homes/${homeA}/pulse`,
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: roommate.cookie,
            },
          });
          assert.equal(roommateRes.status, 200);
          assert.equal(
            roommateRes.headers.get('cache-control'),
            'private, no-store',
          );
          const roommateBody = housePulseDtoSchema.parse(roommateRes.json());
          assert.equal(roommateBody.items.length, 3);
          assert.deepEqual(
            roommateBody.items.map((item) => item.type),
            ['TASKS', 'SUPPLIES', 'MAINTENANCE'],
          );

          const adminRes = await request({
            method: 'GET',
            path: `/api/v1/homes/${homeA}/pulse`,
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: admin.cookie,
            },
          });
          assert.equal(adminRes.status, 200);
          const adminBody = housePulseDtoSchema.parse(adminRes.json());
          assert.deepEqual(
            { ...adminBody, generatedAt: '' },
            { ...roommateBody, generatedAt: '' },
          );

          const stale = await request({
            method: 'GET',
            path: `/api/v1/homes/${homeB}/pulse`,
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: roommate.cookie,
            },
          });
          assert.equal(stale.status, 404);
          assert.equal((stale.json() as ApiErrorBody).error.code, 'NOT_FOUND');

          const crossHome = await request({
            method: 'GET',
            path: `/api/v1/homes/${homeB}/pulse`,
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: roommate.cookie,
            },
          });
          assert.equal(crossHome.status, 404);

          const archived = await request({
            method: 'GET',
            path: `/api/v1/homes/${archivedHome}/pulse`,
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: roommate.cookie,
            },
          });
          assert.equal(archived.status, 404);
        });
      } finally {
        if (homeIds.length > 0) {
          await database.pool.query(
            'DELETE FROM memberships WHERE home_id = ANY($1::uuid[])',
            [homeIds],
          );
          await database.pool.query('DELETE FROM homes WHERE id = ANY($1)', [
            homeIds,
          ]);
        }
        for (const id of identityIds) {
          await database.pool.query(
            'DELETE FROM auth_sessions WHERE user_id = $1',
            [id],
          );
          await database.pool.query(
            'DELETE FROM auth_accounts WHERE user_id = $1',
            [id],
          );
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
