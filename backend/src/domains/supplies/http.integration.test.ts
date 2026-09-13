import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createCreateSupplyEntryFromPool } from '../../application/supplies/create-supply-entry.js';
import { createListHomeSuppliesFromPool } from '../../application/supplies/list-home-supplies.js';
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
import {
  assertNoForbiddenLeak,
  COMMON_SECRET_SENTINELS,
} from '../../platform/http/assert-no-forbidden-leak.js';
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
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
import {
  supplyEntryDtoSchema,
  type SupplyEntryDto,
} from './supply-entry-dto.js';
import { SUPPLY_TITLE_MAX_LENGTH } from './supply-title.js';

const TEST_SECRET = 'roomies_test_secret_32_chars_minimum_value';
const TRUSTED_ORIGIN = 'http://127.0.0.1:5173';
const CANONICAL_FRONTEND_ORIGIN = 'http://localhost:5173';
const HOSTILE_ORIGIN = 'https://evil.example';
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

const dtoKeys = [
  'id',
  'title',
  'status',
  'createdByMembershipId',
  'obtainedAt',
  'canceledAt',
  'createdAt',
  'updatedAt',
];

void describe('Supply HTTP PostgreSQL', () => {
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
    'covers create/list authorization, Origin, filters, and safe DTOs',
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
      const logs: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        logs.push(args.map((value) => JSON.stringify(value)).join(' '));
      };

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
            supplies: {
              createSupplyEntry: createCreateSupplyEntryFromPool(database.pool),
              listHomeSupplies: createListHomeSuppliesFromPool(database.pool),
            },
          }),
        });

        await withAppServer(app, async (request) => {
          async function signUp(name: string) {
            const email = `m42-${name}-${randomUUID()}@example.test`;
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
          const other = await signUp('other');
          const ended = await signUp('ended');

          const homeA = createUuidV7();
          const homeB = createUuidV7();
          const archivedHome = createUuidV7();
          homeIds.push(homeA, homeB, archivedHome);
          const membershipA = createUuidV7();
          const membershipB = createUuidV7();
          const endedMembership = createUuidV7();
          const archivedMembership = createUuidV7();

          await insertHome(database.pool, { id: homeA, name: 'Home A' });
          await insertHome(database.pool, { id: homeB, name: 'Home B' });
          await insertHome(database.pool, {
            id: archivedHome,
            name: 'Archived',
            archived: true,
          });
          await insertMembership(database.pool, {
            id: membershipA,
            homeId: homeA,
            userId: roommate.id,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: membershipB,
            homeId: homeB,
            userId: other.id,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: endedMembership,
            homeId: homeA,
            userId: ended.id,
            role: 'ROOMMATE',
            ended: true,
          });
          await insertMembership(database.pool, {
            id: archivedMembership,
            homeId: archivedHome,
            userId: roommate.id,
            role: 'ROOMMATE',
          });

          const created = await request({
            method: 'POST',
            path: `/api/v1/homes/${homeA}/supplies`,
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: roommate.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ title: '  Paper towels  ' }),
          });
          assert.equal(created.status, 201);
          assert.equal(
            created.headers.get('cache-control'),
            'private, no-store',
          );
          const createdBody = supplyEntryDtoSchema.parse(created.json());
          assert.deepEqual(Object.keys(createdBody), dtoKeys);
          assert.equal(createdBody.title, 'Paper towels');
          assert.equal(createdBody.status, 'OPEN');
          assert.equal(createdBody.createdByMembershipId, membershipA);
          assert.equal(createdBody.obtainedAt, null);
          assert.equal(createdBody.canceledAt, null);
          assert.equal('homeId' in (created.json() as object), false);
          assert.equal('activeClaim' in (created.json() as object), false);
          assert.equal('claimedBy' in (created.json() as object), false);
          assert.equal('canClaim' in (created.json() as object), false);

          const listed = await request({
            method: 'GET',
            path: `/api/v1/homes/${homeA}/supplies`,
            headers: { Cookie: roommate.cookie },
          });
          assert.equal(listed.status, 200);
          assert.equal(
            listed.headers.get('cache-control'),
            'private, no-store',
          );
          const listBody = listed.json() as SupplyEntryDto[];
          assert.equal(Array.isArray(listBody), true);
          assert.equal(listBody.length, 1);
          assert.deepEqual(Object.keys(listBody[0] ?? {}), dtoKeys);
          assert.equal(listBody[0]?.id, createdBody.id);

          const listedWithoutOrigin = await request({
            method: 'GET',
            path: `/api/v1/homes/${homeA}/supplies`,
            headers: { Cookie: roommate.cookie },
          });
          assert.equal(listedWithoutOrigin.status, 200);

          const listedHostileOrigin = await request({
            method: 'GET',
            path: `/api/v1/homes/${homeA}/supplies`,
            headers: {
              Origin: HOSTILE_ORIGIN,
              Cookie: roommate.cookie,
            },
          });
          assert.equal(listedHostileOrigin.status, 200);

          const openOnly = await request({
            method: 'GET',
            path: `/api/v1/homes/${homeA}/supplies?status=OPEN`,
            headers: { Cookie: roommate.cookie },
          });
          assert.equal(openOnly.status, 200);
          assert.equal((openOnly.json() as SupplyEntryDto[]).length, 1);

          const invalidStatus = await request({
            method: 'GET',
            path: `/api/v1/homes/${homeA}/supplies?status=CLAIMED`,
            headers: { Cookie: roommate.cookie },
          });
          assert.equal(invalidStatus.status, 400);
          assert.equal(
            (invalidStatus.json() as ApiErrorBody).error.code,
            'INVALID_REQUEST',
          );

          const unauthenticated = await request({
            method: 'GET',
            path: `/api/v1/homes/${homeA}/supplies`,
          });
          assert.equal(unauthenticated.status, 401);

          const hostile = await request({
            method: 'POST',
            path: `/api/v1/homes/${homeA}/supplies`,
            headers: {
              Origin: HOSTILE_ORIGIN,
              Cookie: roommate.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ title: 'Hostile' }),
          });
          assert.equal(hostile.status, 403);

          const missingAuth = await request({
            method: 'POST',
            path: `/api/v1/homes/${homeA}/supplies`,
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ title: 'No auth' }),
          });
          assert.equal(missingAuth.status, 401);

          const extraFields = await request({
            method: 'POST',
            path: `/api/v1/homes/${homeA}/supplies`,
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: roommate.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              title: 'Injected',
              status: 'OBTAINED',
              createdByMembershipId: membershipB,
            }),
          });
          assert.equal(extraFields.status, 400);

          const overlong = await request({
            method: 'POST',
            path: `/api/v1/homes/${homeA}/supplies`,
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: roommate.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              title: 'x'.repeat(SUPPLY_TITLE_MAX_LENGTH + 1),
            }),
          });
          assert.equal(overlong.status, 400);

          const crossHome = await request({
            method: 'GET',
            path: `/api/v1/homes/${homeB}/supplies`,
            headers: { Cookie: roommate.cookie },
          });
          assert.equal(crossHome.status, 404);
          assert.equal(
            (crossHome.json() as ApiErrorBody).error.code,
            'NOT_FOUND',
          );

          const endedList = await request({
            method: 'GET',
            path: `/api/v1/homes/${homeA}/supplies`,
            headers: { Cookie: ended.cookie },
          });
          assert.equal(endedList.status, 404);

          const archivedList = await request({
            method: 'GET',
            path: `/api/v1/homes/${archivedHome}/supplies`,
            headers: { Cookie: roommate.cookie },
          });
          assert.equal(archivedList.status, 404);

          const leftover = await database.pool.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM supply_entries
             WHERE home_id = $1 AND title IN ('Hostile', 'No auth', 'Injected')`,
            [homeA],
          );
          assert.equal(leftover.rows[0]?.count, '0');

          const claims = await database.pool.query<{ count: string }>(
            'SELECT count(*)::text AS count FROM supply_claims WHERE home_id = $1',
            [homeA],
          );
          assert.equal(claims.rows[0]?.count, '0');

          assertNoForbiddenLeak({
            context: 'supply HTTP logs',
            text: logs.join('\n'),
            forbidden: [...COMMON_SECRET_SENTINELS, PASSWORD],
          });
        });
      } finally {
        console.error = originalError;
        await database.pool.query(
          'DELETE FROM supply_claims WHERE home_id = ANY($1::uuid[])',
          [homeIds],
        );
        await database.pool.query(
          'DELETE FROM supply_entries WHERE home_id = ANY($1::uuid[])',
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
