import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createCreateMaintenanceEntryFromPool } from '../../application/maintenance/create-maintenance-entry.js';
import { createHomeRepository } from '../homes/index.js';
import { createRoomiesApiRouter } from '../../http/create-roomies-api.js';
import { createActiveHomeActorResolver } from '../memberships/index.js';
import {
  createCanonicalUserLookup,
  createPrincipalResolver,
} from '../../platform/auth/principal.js';
import { createAuthRuntime } from '../../platform/auth/runtime.js';
import type { AppConfig } from '../../platform/config/types.js';
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
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
import { maintenanceDetailDtoSchema } from './maintenance-entry-dto.js';
import { MAINTENANCE_DETAILS_MAX_LENGTH } from './maintenance-details.js';
import { MAINTENANCE_TITLE_MAX_LENGTH } from './maintenance-title.js';

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

async function entryCount(pool: Pool, homeId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM maintenance_entries WHERE home_id = $1`,
    [homeId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

const dtoKeys = [
  'id',
  'title',
  'status',
  'visibility',
  'createdByMembershipId',
  'resolvedByMembershipId',
  'resolvedAt',
  'createdAt',
  'updatedAt',
  'details',
];

const leakSentinels = [
  ...COMMON_SECRET_SENTINELS,
  'audienceMembershipIds',
  'audience',
  'foreign',
  'ended membership',
  'membership exists',
  'userId',
  'role',
  'SELECT',
  'stack',
];

void describe('Maintenance HTTP PostgreSQL', () => {
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
    'covers create authorization, Origin, validation, concealment, and safe DTOs',
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
            maintenance: {
              createMaintenanceEntry: createCreateMaintenanceEntryFromPool(
                database.pool,
              ),
            },
          }),
        });

        await withAppServer(app, async (request) => {
          async function signUp(name: string) {
            const email = `m52-${name}-${randomUUID()}@example.test`;
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
          const other = await signUp('other');
          const ended = await signUp('ended');

          const homeA = createUuidV7();
          const homeB = createUuidV7();
          const archivedHome = createUuidV7();
          homeIds.push(homeA, homeB, archivedHome);
          const membershipA = createUuidV7();
          const membershipAdmin = createUuidV7();
          const recipientA = createUuidV7();
          const endedMembership = createUuidV7();
          const archivedMembership = createUuidV7();
          const foreignMembership = createUuidV7();
          const missingMembership = createUuidV7();

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
            id: membershipAdmin,
            homeId: homeA,
            userId: admin.id,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: recipientA,
            homeId: homeA,
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
          await insertMembership(database.pool, {
            id: foreignMembership,
            homeId: homeB,
            userId: other.id,
            role: 'ADMIN',
          });

          const household = await request({
            method: 'POST',
            path: `/api/v1/homes/${homeA}/maintenance`,
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: roommate.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              visibility: 'HOUSEHOLD',
              title: '  Leaky faucet  ',
              details: 'Kitchen sink',
            }),
          });
          assert.equal(household.status, 201);
          assert.equal(
            household.headers.get('cache-control'),
            'private, no-store',
          );
          const householdBody = maintenanceDetailDtoSchema.parse(
            household.json(),
          );
          assert.deepEqual(Object.keys(householdBody), dtoKeys);
          assert.equal(householdBody.visibility, 'HOUSEHOLD');
          assert.equal(householdBody.title, 'Leaky faucet');
          assert.equal(householdBody.details, 'Kitchen sink');
          assert.equal(householdBody.status, 'OPEN');
          assert.equal(householdBody.createdByMembershipId, membershipA);
          assert.equal('homeId' in (household.json() as object), false);
          assert.equal(
            'audienceMembershipIds' in (household.json() as object),
            false,
          );

          const adminHousehold = await request({
            method: 'POST',
            path: `/api/v1/homes/${homeA}/maintenance`,
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: admin.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              visibility: 'HOUSEHOLD',
              title: 'Admin household',
            }),
          });
          assert.equal(adminHousehold.status, 201);

          const creatorOnly = await request({
            method: 'POST',
            path: `/api/v1/homes/${homeA}/maintenance`,
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: roommate.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              visibility: 'PRIVATE',
              title: 'Creator only',
              audienceMembershipIds: [],
            }),
          });
          assert.equal(creatorOnly.status, 201);
          const creatorOnlyBody = maintenanceDetailDtoSchema.parse(
            creatorOnly.json(),
          );
          assert.equal(creatorOnlyBody.visibility, 'PRIVATE');
          assert.equal(
            'audienceMembershipIds' in (creatorOnly.json() as object),
            false,
          );

          const withRecipient = await request({
            method: 'POST',
            path: `/api/v1/homes/${homeA}/maintenance`,
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: roommate.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              visibility: 'PRIVATE',
              title: 'Shared private',
              audienceMembershipIds: [recipientA],
            }),
          });
          assert.equal(withRecipient.status, 201);
          assert.equal(
            'audienceMembershipIds' in (withRecipient.json() as object),
            false,
          );

          const adminPrivate = await request({
            method: 'POST',
            path: `/api/v1/homes/${homeA}/maintenance`,
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: admin.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              visibility: 'PRIVATE',
              title: 'Admin private',
              audienceMembershipIds: [],
            }),
          });
          assert.equal(adminPrivate.status, 201);

          const hostile = await request({
            method: 'POST',
            path: `/api/v1/homes/${homeA}/maintenance`,
            headers: {
              Origin: HOSTILE_ORIGIN,
              Cookie: roommate.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              visibility: 'HOUSEHOLD',
              title: 'Hostile',
            }),
          });
          assert.equal(hostile.status, 403);
          assert.equal(
            (hostile.json() as ApiErrorBody).error.code,
            'FORBIDDEN',
          );

          const missingOrigin = await request({
            method: 'POST',
            path: `/api/v1/homes/${homeA}/maintenance`,
            headers: {
              Cookie: roommate.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              visibility: 'HOUSEHOLD',
              title: 'Missing origin',
            }),
          });
          assert.equal(missingOrigin.status, 403);

          const invalidBodies = [
            { visibility: 'HOUSEHOLD', title: 'ok', extra: 1 },
            { visibility: 'PUBLIC', title: 'ok' },
            { visibility: 'HOUSEHOLD', title: '   ' },
            {
              visibility: 'HOUSEHOLD',
              title: 'x'.repeat(MAINTENANCE_TITLE_MAX_LENGTH + 1),
            },
            {
              visibility: 'HOUSEHOLD',
              title: 'ok',
              details: 'x'.repeat(MAINTENANCE_DETAILS_MAX_LENGTH + 1),
            },
            { visibility: 'PRIVATE', title: 'ok' },
            { visibility: 'PRIVATE', title: 'ok', audienceMembershipIds: null },
            { visibility: 'HOUSEHOLD', title: 'ok', audienceMembershipIds: [] },
            {
              visibility: 'HOUSEHOLD',
              title: 'ok',
              audienceMembershipIds: [membershipA],
            },
            {
              visibility: 'PRIVATE',
              title: 'ok',
              audienceMembershipIds: ['not-a-uuid'],
            },
          ];
          for (const body of invalidBodies) {
            const res = await request({
              method: 'POST',
              path: `/api/v1/homes/${homeA}/maintenance`,
              headers: {
                Origin: TRUSTED_ORIGIN,
                Cookie: roommate.cookie,
                'content-type': 'application/json',
              },
              body: JSON.stringify(body),
            });
            assert.equal(res.status, 400);
            assert.equal(
              (res.json() as ApiErrorBody).error.code,
              'INVALID_REQUEST',
            );
          }

          const nonexistentHome = createUuidV7();
          const missingHome = await request({
            method: 'POST',
            path: `/api/v1/homes/${nonexistentHome}/maintenance`,
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: roommate.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              visibility: 'HOUSEHOLD',
              title: 'Missing home',
            }),
          });
          assert.equal(missingHome.status, 404);
          assert.equal(
            (missingHome.json() as ApiErrorBody).error.code,
            'NOT_FOUND',
          );

          const archived = await request({
            method: 'POST',
            path: `/api/v1/homes/${archivedHome}/maintenance`,
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: roommate.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              visibility: 'HOUSEHOLD',
              title: 'Archived home',
            }),
          });
          assert.equal(archived.status, 404);

          const staleActor = await request({
            method: 'POST',
            path: `/api/v1/homes/${homeA}/maintenance`,
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: ended.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              visibility: 'HOUSEHOLD',
              title: 'Ended actor',
            }),
          });
          assert.equal(staleActor.status, 404);

          const crossHome = await request({
            method: 'POST',
            path: `/api/v1/homes/${homeB}/maintenance`,
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: roommate.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              visibility: 'HOUSEHOLD',
              title: 'Cross home',
            }),
          });
          assert.equal(crossHome.status, 404);

          const concealedCases = [
            {
              label: 'foreign',
              audienceMembershipIds: [foreignMembership],
            },
            {
              label: 'ended',
              audienceMembershipIds: [endedMembership],
            },
            {
              label: 'missing',
              audienceMembershipIds: [missingMembership],
            },
          ];
          const concealedResponses: Array<{ code: string; message: string }> =
            [];
          for (const testCase of concealedCases) {
            const before = await entryCount(database.pool, homeA);
            const res = await request({
              method: 'POST',
              path: `/api/v1/homes/${homeA}/maintenance`,
              headers: {
                Origin: TRUSTED_ORIGIN,
                Cookie: roommate.cookie,
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                visibility: 'PRIVATE',
                title: testCase.label,
                audienceMembershipIds: testCase.audienceMembershipIds,
              }),
            });
            assert.equal(res.status, 404);
            const error = (res.json() as ApiErrorBody).error;
            assert.equal(error.code, 'NOT_FOUND');
            assert.equal(error.message, 'Not found');
            concealedResponses.push({
              code: error.code,
              message: error.message,
            });
            assert.equal(await entryCount(database.pool, homeA), before);
            assertNoForbiddenLeak({
              context: `concealed audience ${testCase.label}`,
              text: res.text,
              forbidden: [...leakSentinels, ...testCase.audienceMembershipIds],
            });
          }
          assert.deepEqual(concealedResponses[0], concealedResponses[1]);
          assert.deepEqual(concealedResponses[1], concealedResponses[2]);

          const beforeHouseholdReject = await entryCount(database.pool, homeA);
          const householdAudience = await request({
            method: 'POST',
            path: `/api/v1/homes/${homeA}/maintenance`,
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: roommate.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              visibility: 'HOUSEHOLD',
              title: 'Bad audience',
              audienceMembershipIds: [],
            }),
          });
          assert.equal(householdAudience.status, 400);
          assert.equal(
            await entryCount(database.pool, homeA),
            beforeHouseholdReject,
          );

          const beforePrivateReject = await entryCount(database.pool, homeA);
          const privateMissingAudience = await request({
            method: 'POST',
            path: `/api/v1/homes/${homeA}/maintenance`,
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: roommate.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              visibility: 'PRIVATE',
              title: 'Missing audience',
            }),
          });
          assert.equal(privateMissingAudience.status, 400);
          assert.equal(
            await entryCount(database.pool, homeA),
            beforePrivateReject,
          );

          const leftover = await database.pool.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM maintenance_entries
             WHERE home_id = $1 AND title IN ('Hostile', 'Missing origin', 'Bad audience', 'Missing audience', 'foreign', 'ended', 'missing')`,
            [homeA],
          );
          assert.equal(leftover.rows[0]?.count, '0');

          const successTitles = [householdBody.title, creatorOnlyBody.title];
          assert.ok(successTitles.includes('Leaky faucet'));
          assert.ok(successTitles.includes('Creator only'));
        });
      } finally {
        console.error = originalError;
        if (homeIds.length > 0) {
          await database.pool.query(
            'DELETE FROM maintenance_audiences WHERE home_id = ANY($1)',
            [homeIds],
          );
          await database.pool.query(
            'DELETE FROM maintenance_entries WHERE home_id = ANY($1)',
            [homeIds],
          );
          await database.pool.query(
            'DELETE FROM memberships WHERE home_id = ANY($1)',
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
