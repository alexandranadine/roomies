import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createCreateMaintenanceEntryFromPool } from '../../application/maintenance/create-maintenance-entry.js';
import { createListHomeMaintenanceFromPool } from '../../application/maintenance/list-home-maintenance.js';
import { createReadMaintenanceEntryFromPool } from '../../application/maintenance/read-maintenance-entry.js';
import { createResolveMaintenanceEntryFromPool } from '../../application/maintenance/resolve-maintenance-entry.js';
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
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import { createDb } from '../../prisma/db.js';
import {
  encodeMaintenanceListCursor,
  MAINTENANCE_LIST_QUERY_FINGERPRINT,
} from './cursor.js';
import {
  maintenanceDetailDtoSchema,
  maintenanceListPageDtoSchema,
} from './maintenance-entry-dto.js';
import { MAINTENANCE_DETAILS_MAX_LENGTH } from './maintenance-details.js';
import { MAINTENANCE_TITLE_MAX_LENGTH } from './maintenance-title.js';
import {
  createMaintenanceRepository,
  type NewMaintenanceEntry,
} from './repository.js';

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

const listDtoKeys = [
  'id',
  'title',
  'status',
  'visibility',
  'createdByMembershipId',
  'resolvedByMembershipId',
  'resolvedAt',
  'createdAt',
  'updatedAt',
];

const CREATED = new Date('2026-09-13T12:00:00.000Z');

function entryInput(
  id: string,
  homeId: string,
  createdByMembershipId: string,
  visibility: 'HOUSEHOLD' | 'PRIVATE',
  title: string,
  updatedAt = CREATED,
): NewMaintenanceEntry {
  return {
    id,
    homeId,
    createdByMembershipId,
    visibility,
    title,
    details: `${title} details`,
    status: 'OPEN',
    resolvedByMembershipId: null,
    resolvedAt: null,
    createdAt: CREATED,
    updatedAt,
  };
}

function errorShape(res: { status: number; json: () => unknown }): {
  status: number;
  code: string;
  message: string;
} {
  const error = (res.json() as ApiErrorBody).error;
  return { status: res.status, code: error.code, message: error.message };
}

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
              listHomeMaintenance: createListHomeMaintenanceFromPool(
                database.pool,
              ),
              readMaintenanceEntry: createReadMaintenanceEntryFromPool(
                database.pool,
              ),
              resolveMaintenanceEntry: createResolveMaintenanceEntryFromPool(
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

  void it(
    'enforces visible list/detail privacy, pagination, cursors, tenure, archive, and cross-Home through HTTP',
    { skip: skipWithoutDatabase, timeout: 90_000 },
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
      const repository = createMaintenanceRepository(database.pool);

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
              listHomeMaintenance: createListHomeMaintenanceFromPool(
                database.pool,
              ),
              readMaintenanceEntry: createReadMaintenanceEntryFromPool(
                database.pool,
              ),
              resolveMaintenanceEntry: createResolveMaintenanceEntryFromPool(
                database.pool,
              ),
            },
          }),
        });

        await withAppServer(app, async (request) => {
          async function signUp(name: string) {
            const email = `m53-${name}-${randomUUID()}@example.test`;
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

          async function insertEntry(
            entry: NewMaintenanceEntry,
            audienceMembershipIds: readonly string[],
          ) {
            await runInReadCommittedTransaction(database.pool, async (tx) => {
              await repository.insertEntryWithAudience(tx, {
                entry,
                audienceMembershipIds,
              });
            });
          }

          function listPath(targetHomeId: string, query = ''): string {
            return `/api/v1/homes/${targetHomeId}/maintenance${query}`;
          }

          function detailPath(targetHomeId: string, entryId: string): string {
            return `/api/v1/homes/${targetHomeId}/maintenance/${entryId}`;
          }

          const alex = await signUp('alex');
          const jamie = await signUp('jamie');
          const taylor = await signUp('taylor');
          const foreign = await signUp('foreign');
          const tenureUser = await signUp('tenure');

          const homeId = createUuidV7();
          const pageHomeId = createUuidV7();
          const foreignHomeId = createUuidV7();
          const tenureHomeId = createUuidV7();
          const archivedHomeId = createUuidV7();
          homeIds.push(
            homeId,
            pageHomeId,
            foreignHomeId,
            tenureHomeId,
            archivedHomeId,
          );

          const alexMembership = createUuidV7();
          const jamieMembership = createUuidV7();
          const taylorMembership = createUuidV7();
          const pageAlex = createUuidV7();
          const pageJamie = createUuidV7();
          const foreignMembership = createUuidV7();
          const tenureA = createUuidV7();
          const tenureB = createUuidV7();
          const archivedMembership = createUuidV7();
          const privateA = createUuidV7();
          const privateB = createUuidV7();
          const householdH = createUuidV7();
          const foreignEntry = createUuidV7();
          const tenurePrivate = createUuidV7();
          const tenureHousehold = createUuidV7();
          const archivedEntry = createUuidV7();
          const v1 = createUuidV7();
          const v2 = createUuidV7();
          const v3 = createUuidV7();
          const v4 = createUuidV7();
          const v5 = createUuidV7();
          const hidden1 = createUuidV7();
          const hidden2 = createUuidV7();
          const hidden3 = createUuidV7();

          await insertHome(database.pool, { id: homeId, name: 'Sentinel' });
          await insertHome(database.pool, { id: pageHomeId, name: 'Pages' });
          await insertHome(database.pool, {
            id: foreignHomeId,
            name: 'Foreign',
          });
          await insertHome(database.pool, { id: tenureHomeId, name: 'Tenure' });
          await insertHome(database.pool, {
            id: archivedHomeId,
            name: 'Archived',
          });
          await insertMembership(database.pool, {
            id: alexMembership,
            homeId,
            userId: alex.id,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: jamieMembership,
            homeId,
            userId: jamie.id,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: taylorMembership,
            homeId,
            userId: taylor.id,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: pageAlex,
            homeId: pageHomeId,
            userId: alex.id,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: pageJamie,
            homeId: pageHomeId,
            userId: jamie.id,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: foreignMembership,
            homeId: foreignHomeId,
            userId: foreign.id,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: tenureA,
            homeId: tenureHomeId,
            userId: tenureUser.id,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: archivedMembership,
            homeId: archivedHomeId,
            userId: tenureUser.id,
            role: 'ROOMMATE',
          });

          await insertEntry(
            entryInput(
              privateA,
              homeId,
              alexMembership,
              'PRIVATE',
              'Private A',
              new Date('2026-09-13T12:20:00.000Z'),
            ),
            [alexMembership],
          );
          await insertEntry(
            entryInput(
              privateB,
              homeId,
              jamieMembership,
              'PRIVATE',
              'Private B',
              new Date('2026-09-13T12:10:00.000Z'),
            ),
            [jamieMembership],
          );
          await insertEntry(
            entryInput(
              householdH,
              homeId,
              taylorMembership,
              'HOUSEHOLD',
              'Household H',
              new Date('2026-09-13T12:30:00.000Z'),
            ),
            [],
          );
          await insertEntry(
            entryInput(
              foreignEntry,
              foreignHomeId,
              foreignMembership,
              'HOUSEHOLD',
              'Foreign household',
            ),
            [],
          );

          const alexList = await request({
            method: 'GET',
            path: listPath(homeId),
            headers: { Cookie: alex.cookie },
          });
          assert.equal(alexList.status, 200);
          assert.equal(
            alexList.headers.get('cache-control'),
            'private, no-store',
          );
          const alexPage = maintenanceListPageDtoSchema.parse(alexList.json());
          assert.deepEqual(
            alexPage.items.map((item) => item.id),
            [householdH, privateA],
          );
          assert.equal(
            alexPage.items.some((item) => item.id === privateB),
            false,
          );
          assert.equal('details' in (alexPage.items[0] ?? {}), false);
          assert.deepEqual(Object.keys(alexPage.items[0] ?? {}), listDtoKeys);

          const jamieList = await request({
            method: 'GET',
            path: listPath(homeId),
            headers: { Cookie: jamie.cookie },
          });
          const jamiePage = maintenanceListPageDtoSchema.parse(
            jamieList.json(),
          );
          assert.deepEqual(
            jamiePage.items.map((item) => item.id),
            [householdH, privateB],
          );
          assert.equal(
            jamiePage.items.some((item) => item.id === privateA),
            false,
          );

          const taylorList = await request({
            method: 'GET',
            path: listPath(homeId),
            headers: { Cookie: taylor.cookie },
          });
          const taylorPage = maintenanceListPageDtoSchema.parse(
            taylorList.json(),
          );
          assert.deepEqual(
            taylorPage.items.map((item) => item.id),
            [householdH],
          );
          assert.equal(
            taylorPage.items.some((item) => item.id === privateA),
            false,
          );
          assert.equal(
            taylorPage.items.some((item) => item.id === privateB),
            false,
          );

          const alexA = await request({
            method: 'GET',
            path: detailPath(homeId, privateA),
            headers: { Cookie: alex.cookie },
          });
          assert.equal(alexA.status, 200);
          const alexABody = maintenanceDetailDtoSchema.parse(alexA.json());
          assert.equal(alexABody.details, 'Private A details');
          assert.equal(alexA.headers.get('cache-control'), 'private, no-store');

          const alexB = await request({
            method: 'GET',
            path: detailPath(homeId, privateB),
            headers: { Cookie: alex.cookie },
          });
          const jamieB = await request({
            method: 'GET',
            path: detailPath(homeId, privateB),
            headers: { Cookie: jamie.cookie },
          });
          const jamieA = await request({
            method: 'GET',
            path: detailPath(homeId, privateA),
            headers: { Cookie: jamie.cookie },
          });
          const taylorH = await request({
            method: 'GET',
            path: detailPath(homeId, householdH),
            headers: { Cookie: taylor.cookie },
          });
          const taylorA = await request({
            method: 'GET',
            path: detailPath(homeId, privateA),
            headers: { Cookie: taylor.cookie },
          });
          const taylorB = await request({
            method: 'GET',
            path: detailPath(homeId, privateB),
            headers: { Cookie: taylor.cookie },
          });
          assert.equal(jamieB.status, 200);
          assert.equal(taylorH.status, 200);
          const concealed = [alexB, jamieA, taylorA, taylorB].map(errorShape);
          for (const shape of concealed) {
            assert.deepEqual(shape, {
              status: 404,
              code: 'NOT_FOUND',
              message: 'Not found',
            });
          }
          assert.deepEqual(concealed[0], concealed[1]);

          const t50 = new Date('2026-09-13T13:50:00.000Z');
          const t45 = new Date('2026-09-13T13:45:00.000Z');
          const t40 = new Date('2026-09-13T13:40:00.000Z');
          const t35 = new Date('2026-09-13T13:35:00.000Z');
          const t30 = new Date('2026-09-13T13:30:00.000Z');
          const t25 = new Date('2026-09-13T13:25:00.000Z');
          const t20 = new Date('2026-09-13T13:20:00.000Z');
          const t10 = new Date('2026-09-13T13:10:00.000Z');
          await insertEntry(
            entryInput(v1, pageHomeId, pageAlex, 'HOUSEHOLD', 'V1', t50),
            [],
          );
          await insertEntry(
            entryInput(hidden1, pageHomeId, pageJamie, 'PRIVATE', 'H1', t45),
            [pageJamie],
          );
          await insertEntry(
            entryInput(v2, pageHomeId, pageAlex, 'HOUSEHOLD', 'V2', t40),
            [],
          );
          await insertEntry(
            entryInput(hidden2, pageHomeId, pageJamie, 'PRIVATE', 'H2', t35),
            [pageJamie],
          );
          await insertEntry(
            entryInput(v3, pageHomeId, pageAlex, 'HOUSEHOLD', 'V3', t30),
            [],
          );
          await insertEntry(
            entryInput(hidden3, pageHomeId, pageJamie, 'PRIVATE', 'H3', t25),
            [pageJamie],
          );
          await insertEntry(
            entryInput(v4, pageHomeId, pageAlex, 'PRIVATE', 'V4', t20),
            [pageAlex],
          );
          await insertEntry(
            entryInput(v5, pageHomeId, pageAlex, 'HOUSEHOLD', 'V5', t10),
            [],
          );

          const visibleOrder = [v1, v2, v3, v4, v5];
          const page1 = await request({
            method: 'GET',
            path: listPath(pageHomeId, '?limit=2'),
            headers: { Cookie: alex.cookie },
          });
          const page1Body = maintenanceListPageDtoSchema.parse(page1.json());
          assert.deepEqual(
            page1Body.items.map((item) => item.id),
            [v1, v2],
          );
          assert.equal(page1Body.hasMore, true);
          assert.equal(typeof page1Body.nextCursor, 'string');
          assert.equal(
            page1Body.items.some((item) =>
              [hidden1, hidden2, hidden3].includes(item.id),
            ),
            false,
          );

          const page2 = await request({
            method: 'GET',
            path: listPath(
              pageHomeId,
              `?limit=2&cursor=${encodeURIComponent(page1Body.nextCursor ?? '')}`,
            ),
            headers: { Cookie: alex.cookie },
          });
          const page2Body = maintenanceListPageDtoSchema.parse(page2.json());
          assert.deepEqual(
            page2Body.items.map((item) => item.id),
            [v3, v4],
          );
          assert.equal(page2Body.hasMore, true);

          const page3 = await request({
            method: 'GET',
            path: listPath(
              pageHomeId,
              `?limit=2&cursor=${encodeURIComponent(page2Body.nextCursor ?? '')}`,
            ),
            headers: { Cookie: alex.cookie },
          });
          const page3Body = maintenanceListPageDtoSchema.parse(page3.json());
          assert.deepEqual(
            page3Body.items.map((item) => item.id),
            [v5],
          );
          assert.equal(page3Body.hasMore, false);
          assert.equal(page3Body.nextCursor, null);

          const pagedIds = [
            ...page1Body.items,
            ...page2Body.items,
            ...page3Body.items,
          ].map((item) => item.id);
          assert.deepEqual(pagedIds, visibleOrder);
          assert.equal(new Set(pagedIds).size, 5);

          const continued = await request({
            method: 'GET',
            path: listPath(
              pageHomeId,
              `?limit=2&cursor=${encodeURIComponent(page1Body.nextCursor ?? '')}`,
            ),
            headers: { Cookie: alex.cookie },
          });
          assert.equal(continued.status, 200);
          assert.deepEqual(
            maintenanceListPageDtoSchema
              .parse(continued.json())
              .items.map((item) => item.id),
            [v3, v4],
          );

          const malformed = await request({
            method: 'GET',
            path: listPath(pageHomeId, `?cursor=${encodeURIComponent('%%%')}`),
            headers: { Cookie: alex.cookie },
          });
          assert.deepEqual(errorShape(malformed), {
            status: 400,
            code: 'INVALID_REQUEST',
            message: 'Invalid request',
          });
          assert.equal(malformed.text.includes('%%%'), false);

          const homeMismatchCursor = encodeMaintenanceListCursor({
            v: 1,
            statusRank: 0,
            updatedAt: t50.toISOString(),
            id: v1,
            homeId: foreignHomeId,
            actorMembershipId: pageAlex,
            statusFilter: null,
            queryFingerprint: MAINTENANCE_LIST_QUERY_FINGERPRINT,
          });
          const homeMismatch = await request({
            method: 'GET',
            path: listPath(
              pageHomeId,
              `?cursor=${encodeURIComponent(homeMismatchCursor)}`,
            ),
            headers: { Cookie: alex.cookie },
          });
          assert.deepEqual(errorShape(homeMismatch), {
            status: 400,
            code: 'INVALID_REQUEST',
            message: 'Invalid request',
          });

          const actorMismatch = await request({
            method: 'GET',
            path: listPath(
              pageHomeId,
              `?cursor=${encodeURIComponent(page1Body.nextCursor ?? '')}`,
            ),
            headers: { Cookie: jamie.cookie },
          });
          assert.deepEqual(errorShape(actorMismatch), {
            status: 400,
            code: 'INVALID_REQUEST',
            message: 'Invalid request',
          });

          const statusMismatch = await request({
            method: 'GET',
            path: listPath(
              pageHomeId,
              `?status=OPEN&cursor=${encodeURIComponent(page1Body.nextCursor ?? '')}`,
            ),
            headers: { Cookie: alex.cookie },
          });
          assert.deepEqual(errorShape(statusMismatch), {
            status: 400,
            code: 'INVALID_REQUEST',
            message: 'Invalid request',
          });

          await insertEntry(
            entryInput(
              tenurePrivate,
              tenureHomeId,
              tenureA,
              'PRIVATE',
              'Tenure private',
            ),
            [tenureA],
          );
          await insertEntry(
            entryInput(
              tenureHousehold,
              tenureHomeId,
              tenureA,
              'HOUSEHOLD',
              'Tenure household',
            ),
            [],
          );
          const tenureListBefore = await request({
            method: 'GET',
            path: listPath(tenureHomeId, '?limit=1'),
            headers: { Cookie: tenureUser.cookie },
          });
          const tenurePageBefore = maintenanceListPageDtoSchema.parse(
            tenureListBefore.json(),
          );
          assert.equal(tenureListBefore.status, 200);
          const oldCursor = tenurePageBefore.nextCursor;
          assert.equal(typeof oldCursor, 'string');
          const tenureDetailBefore = await request({
            method: 'GET',
            path: detailPath(tenureHomeId, tenurePrivate),
            headers: { Cookie: tenureUser.cookie },
          });
          assert.equal(tenureDetailBefore.status, 200);

          await database.pool.query(
            'UPDATE memberships SET ended_at = NOW() WHERE id = $1',
            [tenureA],
          );
          const endedActorList = await request({
            method: 'GET',
            path: listPath(tenureHomeId),
            headers: { Cookie: tenureUser.cookie },
          });
          const endedActorDetail = await request({
            method: 'GET',
            path: detailPath(tenureHomeId, tenurePrivate),
            headers: { Cookie: tenureUser.cookie },
          });
          assert.deepEqual(errorShape(endedActorList), {
            status: 404,
            code: 'NOT_FOUND',
            message: 'Not found',
          });
          assert.deepEqual(
            errorShape(endedActorDetail),
            errorShape(endedActorList),
          );
          await insertMembership(database.pool, {
            id: tenureB,
            homeId: tenureHomeId,
            userId: tenureUser.id,
            role: 'ROOMMATE',
          });

          const tenureDetailAfter = await request({
            method: 'GET',
            path: detailPath(tenureHomeId, tenurePrivate),
            headers: { Cookie: tenureUser.cookie },
          });
          assert.deepEqual(errorShape(tenureDetailAfter), {
            status: 404,
            code: 'NOT_FOUND',
            message: 'Not found',
          });
          const tenureListAfter = await request({
            method: 'GET',
            path: listPath(tenureHomeId),
            headers: { Cookie: tenureUser.cookie },
          });
          const tenurePageAfter = maintenanceListPageDtoSchema.parse(
            tenureListAfter.json(),
          );
          assert.deepEqual(
            tenurePageAfter.items.map((item) => item.id),
            [tenureHousehold],
          );
          const reusedCursor = await request({
            method: 'GET',
            path: listPath(
              tenureHomeId,
              `?limit=1&cursor=${encodeURIComponent(oldCursor ?? '')}`,
            ),
            headers: { Cookie: tenureUser.cookie },
          });
          assert.deepEqual(errorShape(reusedCursor), {
            status: 400,
            code: 'INVALID_REQUEST',
            message: 'Invalid request',
          });

          await insertEntry(
            entryInput(
              archivedEntry,
              archivedHomeId,
              archivedMembership,
              'HOUSEHOLD',
              'Archived household',
            ),
            [],
          );
          await database.pool.query(
            'UPDATE homes SET archived_at = NOW() WHERE id = $1',
            [archivedHomeId],
          );
          const archivedList = await request({
            method: 'GET',
            path: listPath(archivedHomeId),
            headers: { Cookie: tenureUser.cookie },
          });
          const archivedDetail = await request({
            method: 'GET',
            path: detailPath(archivedHomeId, archivedEntry),
            headers: { Cookie: tenureUser.cookie },
          });
          assert.deepEqual(errorShape(archivedList), {
            status: 404,
            code: 'NOT_FOUND',
            message: 'Not found',
          });
          assert.deepEqual(
            errorShape(archivedDetail),
            errorShape(archivedList),
          );
          assert.equal(await entryCount(database.pool, archivedHomeId), 1);

          const crossThroughA = await request({
            method: 'GET',
            path: detailPath(homeId, foreignEntry),
            headers: { Cookie: alex.cookie },
          });
          const crossThroughB = await request({
            method: 'GET',
            path: detailPath(foreignHomeId, foreignEntry),
            headers: { Cookie: alex.cookie },
          });
          const randomId = createUuidV7();
          const randomMissing = await request({
            method: 'GET',
            path: detailPath(homeId, randomId),
            headers: { Cookie: alex.cookie },
          });
          assert.deepEqual(errorShape(crossThroughA), {
            status: 404,
            code: 'NOT_FOUND',
            message: 'Not found',
          });
          assert.deepEqual(
            errorShape(crossThroughB),
            errorShape(crossThroughA),
          );
          assert.deepEqual(
            errorShape(randomMissing),
            errorShape(crossThroughA),
          );
          const sentinelListAgain = await request({
            method: 'GET',
            path: listPath(homeId),
            headers: { Cookie: alex.cookie },
          });
          assert.equal(
            maintenanceListPageDtoSchema
              .parse(sentinelListAgain.json())
              .items.some((item) => item.id === foreignEntry),
            false,
          );

          const emptyHomeId = createUuidV7();
          homeIds.push(emptyHomeId);
          const emptyMembership = createUuidV7();
          await insertHome(database.pool, { id: emptyHomeId, name: 'Empty' });
          await insertMembership(database.pool, {
            id: emptyMembership,
            homeId: emptyHomeId,
            userId: alex.id,
            role: 'ROOMMATE',
          });
          const validEmpty = await request({
            method: 'GET',
            path: listPath(emptyHomeId),
            headers: { Cookie: alex.cookie },
          });
          assert.equal(validEmpty.status, 200);
          assert.deepEqual(validEmpty.json(), {
            items: [],
            hasMore: false,
            nextCursor: null,
          });

          const staleList = await request({
            method: 'GET',
            path: listPath(homeId),
            headers: { Cookie: tenureUser.cookie },
          });
          const staleDetail = await request({
            method: 'GET',
            path: detailPath(homeId, householdH),
            headers: { Cookie: tenureUser.cookie },
          });
          assert.deepEqual(errorShape(staleList), {
            status: 404,
            code: 'NOT_FOUND',
            message: 'Not found',
          });
          assert.deepEqual(errorShape(staleDetail), errorShape(staleList));
          assert.deepEqual(errorShape(staleDetail), errorShape(alexB));

          assertNoForbiddenLeak({
            context: 'maintenance read/list HTTP logs',
            text: logs.join('\n'),
            forbidden: [
              ...leakSentinels,
              'Private A',
              'Private B',
              page1Body.nextCursor ?? 'next-cursor-missing',
            ],
          });
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

  void it(
    'covers resolve Origin, empty body, privacy, 409, and concealed 404',
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
              listHomeMaintenance: createListHomeMaintenanceFromPool(
                database.pool,
              ),
              readMaintenanceEntry: createReadMaintenanceEntryFromPool(
                database.pool,
              ),
              resolveMaintenanceEntry: createResolveMaintenanceEntryFromPool(
                database.pool,
              ),
            },
          }),
        });

        await withAppServer(app, async (request) => {
          async function signUp(name: string) {
            const email = `m54-${name}-${randomUUID()}@example.test`;
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

          function resolvePath(homeId: string, entryId: string): string {
            return `/api/v1/homes/${homeId}/maintenance/${entryId}/resolve`;
          }

          async function createHousehold(
            cookie: string,
            homeId: string,
            title: string,
          ) {
            const created = await request({
              method: 'POST',
              path: `/api/v1/homes/${homeId}/maintenance`,
              headers: {
                Origin: TRUSTED_ORIGIN,
                Cookie: cookie,
                'content-type': 'application/json',
              },
              body: JSON.stringify({ visibility: 'HOUSEHOLD', title }),
            });
            assert.equal(created.status, 201);
            return maintenanceDetailDtoSchema.parse(created.json());
          }

          async function createPrivate(
            cookie: string,
            homeId: string,
            title: string,
          ) {
            const created = await request({
              method: 'POST',
              path: `/api/v1/homes/${homeId}/maintenance`,
              headers: {
                Origin: TRUSTED_ORIGIN,
                Cookie: cookie,
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                visibility: 'PRIVATE',
                title,
                audienceMembershipIds: [],
              }),
            });
            assert.equal(created.status, 201);
            return maintenanceDetailDtoSchema.parse(created.json());
          }

          const alex = await signUp('alex');
          const jamie = await signUp('jamie');
          const taylor = await signUp('taylor');
          const other = await signUp('other');

          const homeA = createUuidV7();
          const homeB = createUuidV7();
          homeIds.push(homeA, homeB);
          const alexMembership = createUuidV7();
          const jamieMembership = createUuidV7();
          const taylorMembership = createUuidV7();
          const otherMembership = createUuidV7();

          await insertHome(database.pool, { id: homeA, name: 'Resolve A' });
          await insertHome(database.pool, { id: homeB, name: 'Resolve B' });
          await insertMembership(database.pool, {
            id: alexMembership,
            homeId: homeA,
            userId: alex.id,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: jamieMembership,
            homeId: homeA,
            userId: jamie.id,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: taylorMembership,
            homeId: homeA,
            userId: taylor.id,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: otherMembership,
            homeId: homeB,
            userId: other.id,
            role: 'ADMIN',
          });

          const household = await createHousehold(
            alex.cookie,
            homeA,
            'Household resolve',
          );
          const householdConflict = await createHousehold(
            alex.cookie,
            homeA,
            'Already resolved',
          );
          const privateAlex = await createPrivate(
            alex.cookie,
            homeA,
            'Alex private',
          );
          const privateAlexHidden = await createPrivate(
            alex.cookie,
            homeA,
            'Alex hidden',
          );
          const privateJamie = await createPrivate(
            jamie.cookie,
            homeA,
            'Jamie private',
          );
          const privateJamieHidden = await createPrivate(
            jamie.cookie,
            homeA,
            'Jamie hidden',
          );
          const foreign = await createHousehold(
            other.cookie,
            homeB,
            'Foreign household',
          );

          const resolved = await request({
            method: 'POST',
            path: resolvePath(homeA, household.id),
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: alex.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({}),
          });
          assert.equal(resolved.status, 200);
          assert.equal(
            resolved.headers.get('cache-control'),
            'private, no-store',
          );
          const resolvedBody = maintenanceDetailDtoSchema.parse(
            resolved.json(),
          );
          assert.deepEqual(Object.keys(resolvedBody), dtoKeys);
          assert.equal(resolvedBody.status, 'RESOLVED');
          assert.equal(resolvedBody.resolvedByMembershipId, alexMembership);
          assert.notEqual(resolvedBody.resolvedAt, null);
          assert.equal(resolvedBody.updatedAt, resolvedBody.resolvedAt);
          assert.equal('homeId' in (resolved.json() as object), false);
          assert.equal(
            'audienceMembershipIds' in (resolved.json() as object),
            false,
          );

          const hostile = await request({
            method: 'POST',
            path: resolvePath(homeA, householdConflict.id),
            headers: {
              Origin: HOSTILE_ORIGIN,
              Cookie: alex.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({}),
          });
          assert.equal(hostile.status, 403);
          assert.equal(
            (hostile.json() as ApiErrorBody).error.code,
            'FORBIDDEN',
          );

          const missingOrigin = await request({
            method: 'POST',
            path: resolvePath(homeA, householdConflict.id),
            headers: {
              Cookie: alex.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({}),
          });
          assert.equal(missingOrigin.status, 403);

          const unknownKey = await request({
            method: 'POST',
            path: resolvePath(homeA, householdConflict.id),
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: alex.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ note: 'done' }),
          });
          assert.equal(unknownKey.status, 400);
          assert.equal(
            (unknownKey.json() as ApiErrorBody).error.code,
            'INVALID_REQUEST',
          );

          const alexPrivate = await request({
            method: 'POST',
            path: resolvePath(homeA, privateAlex.id),
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: alex.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({}),
          });
          assert.equal(alexPrivate.status, 200);
          assert.equal(
            maintenanceDetailDtoSchema.parse(alexPrivate.json()).visibility,
            'PRIVATE',
          );
          assert.equal(
            'audienceMembershipIds' in (alexPrivate.json() as object),
            false,
          );

          const alexSeesJamie = await request({
            method: 'POST',
            path: resolvePath(homeA, privateJamieHidden.id),
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: alex.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({}),
          });
          assert.deepEqual(errorShape(alexSeesJamie), {
            status: 404,
            code: 'NOT_FOUND',
            message: 'Not found',
          });

          const jamiePrivate = await request({
            method: 'POST',
            path: resolvePath(homeA, privateJamie.id),
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: jamie.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({}),
          });
          assert.equal(jamiePrivate.status, 200);

          const jamieSeesAlex = await request({
            method: 'POST',
            path: resolvePath(homeA, privateAlexHidden.id),
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: jamie.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({}),
          });
          assert.deepEqual(
            errorShape(jamieSeesAlex),
            errorShape(alexSeesJamie),
          );

          const taylorHousehold = await createHousehold(
            taylor.cookie,
            homeA,
            'Taylor household',
          );
          const taylorOk = await request({
            method: 'POST',
            path: resolvePath(homeA, taylorHousehold.id),
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: taylor.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({}),
          });
          assert.equal(taylorOk.status, 200);
          assert.equal(
            maintenanceDetailDtoSchema.parse(taylorOk.json())
              .resolvedByMembershipId,
            taylorMembership,
          );

          const taylorPrivateA = await request({
            method: 'POST',
            path: resolvePath(homeA, privateAlexHidden.id),
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: taylor.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({}),
          });
          const taylorPrivateB = await request({
            method: 'POST',
            path: resolvePath(homeA, privateJamieHidden.id),
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: taylor.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({}),
          });
          assert.deepEqual(
            errorShape(taylorPrivateA),
            errorShape(alexSeesJamie),
          );
          assert.deepEqual(
            errorShape(taylorPrivateB),
            errorShape(alexSeesJamie),
          );

          const firstConflict = await request({
            method: 'POST',
            path: resolvePath(homeA, householdConflict.id),
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: alex.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({}),
          });
          assert.equal(firstConflict.status, 200);
          const secondConflict = await request({
            method: 'POST',
            path: resolvePath(homeA, householdConflict.id),
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: jamie.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({}),
          });
          assert.equal(secondConflict.status, 409);
          assert.equal(
            (secondConflict.json() as ApiErrorBody).error.code,
            'MAINTENANCE_NOT_OPEN',
          );
          assert.equal(
            (secondConflict.json() as ApiErrorBody).error.message,
            'Maintenance is not open',
          );

          const missing = await request({
            method: 'POST',
            path: resolvePath(homeA, createUuidV7()),
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: alex.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({}),
          });
          const viaHomeA = await request({
            method: 'POST',
            path: resolvePath(homeA, foreign.id),
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: alex.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({}),
          });
          const viaHomeB = await request({
            method: 'POST',
            path: resolvePath(homeB, foreign.id),
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: alex.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({}),
          });
          assert.deepEqual(errorShape(missing), {
            status: 404,
            code: 'NOT_FOUND',
            message: 'Not found',
          });
          assert.deepEqual(errorShape(viaHomeA), errorShape(missing));
          assert.deepEqual(errorShape(viaHomeB), errorShape(missing));
          assert.notEqual(errorShape(secondConflict).status, 404);

          const foreignStillOpen = await request({
            method: 'GET',
            path: `/api/v1/homes/${homeB}/maintenance/${foreign.id}`,
            headers: { Cookie: other.cookie },
          });
          assert.equal(foreignStillOpen.status, 200);
          assert.equal(
            maintenanceDetailDtoSchema.parse(foreignStillOpen.json()).status,
            'OPEN',
          );

          assertNoForbiddenLeak({
            context: 'maintenance resolve HTTP',
            text: `${alexSeesJamie.text}\n${taylorPrivateA.text}\n${missing.text}\n${logs.join('\n')}`,
            forbidden: [
              ...leakSentinels,
              'Alex hidden',
              'Jamie hidden',
              'audience',
            ],
          });
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
