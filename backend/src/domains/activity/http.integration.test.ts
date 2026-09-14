import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createListHomeActivityFromPool } from '../../application/activity/list-home-activity.js';
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
import { activityListPageDtoSchema } from './activity-dto.js';
import {
  encodeActivityListCursor,
  ACTIVITY_LIST_QUERY_FINGERPRINT,
} from './cursor.js';
import { createActivityRepository, type NewActivity } from './repository.js';
import { createMaintenanceRepository } from '../maintenance/repository.js';

const TEST_SECRET = 'roomies_test_secret_32_chars_minimum_value';
const TRUSTED_ORIGIN = 'http://127.0.0.1:5173';
const CANONICAL_FRONTEND_ORIGIN = 'http://localhost:5173';
const PASSWORD = 'test-password-only';
const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const CREATED = new Date('2026-09-13T12:00:00.000Z');
const PRIVATE_DETAILS = 'PRIVATE_MAINTENANCE_DETAILS_SENTINEL';
const HOUSEHOLD_DETAILS = 'HOUSEHOLD_MAINTENANCE_DETAILS_SENTINEL';
const PRIVATE_TITLE = 'Private leak title sentinel';

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
    endedByMembershipId?: string;
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
      input.ended === true ? (input.endedByMembershipId ?? input.id) : null,
    ],
  );
}

function activityInput(
  id: string,
  homeId: string,
  occurredAt: Date,
  overrides: Partial<NewActivity> = {},
): NewActivity {
  return {
    id,
    homeId,
    sourceOutboxEventId: overrides.sourceOutboxEventId ?? createUuidV7(),
    sourceEntityType: overrides.sourceEntityType ?? 'MAINTENANCE',
    sourceEntityId: overrides.sourceEntityId ?? id,
    eventType: overrides.eventType ?? 'maintenance.created.v1',
    actorMembershipId:
      overrides.actorMembershipId === undefined
        ? null
        : overrides.actorMembershipId,
    occurredAt,
    createdAt: overrides.createdAt ?? CREATED,
  };
}

async function cleanupHomes(pool: Pool, homeIds: string[]): Promise<void> {
  if (homeIds.length === 0) {
    return;
  }
  await pool.query(
    'DELETE FROM activity_recipients WHERE home_id = ANY($1::uuid[])',
    [homeIds],
  );
  await pool.query('DELETE FROM activities WHERE home_id = ANY($1::uuid[])', [
    homeIds,
  ]);
  await pool.query(
    'DELETE FROM maintenance_audiences WHERE home_id = ANY($1)',
    [homeIds],
  );
  await pool.query('DELETE FROM maintenance_entries WHERE home_id = ANY($1)', [
    homeIds,
  ]);
  await pool.query('DELETE FROM supply_claims WHERE home_id = ANY($1)', [
    homeIds,
  ]);
  await pool.query('DELETE FROM supply_entries WHERE home_id = ANY($1)', [
    homeIds,
  ]);
  await pool.query('DELETE FROM task_instances WHERE home_id = ANY($1)', [
    homeIds,
  ]);
  await pool.query(
    'DELETE FROM membership_role_transitions WHERE home_id = ANY($1)',
    [homeIds],
  );
  await pool.query('DELETE FROM outbox_events WHERE home_id = ANY($1)', [
    homeIds,
  ]);
  await pool.query('DELETE FROM memberships WHERE home_id = ANY($1)', [
    homeIds,
  ]);
  await pool.query('DELETE FROM homes WHERE id = ANY($1)', [homeIds]);
}

function errorShape(res: { status: number; json: () => unknown }): {
  status: number;
  code: string;
  message: string;
} {
  const error = (res.json() as ApiErrorBody).error;
  return { status: res.status, code: error.code, message: error.message };
}

const leakSentinels = [
  ...COMMON_SECRET_SENTINELS,
  'audienceMembershipIds',
  'audience',
  PRIVATE_DETAILS,
  HOUSEHOLD_DETAILS,
  'userId',
  'SELECT',
  'stack',
];

void describe('Activity HTTP PostgreSQL', () => {
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
    'authorizes, pages, and serializes recipient-safe Activity',
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
            activity: {
              listHomeActivity: createListHomeActivityFromPool(database.pool),
            },
          }),
        });

        await withAppServer(app, async (request) => {
          async function signUp(name: string) {
            const email = `m65-${name}-${randomUUID()}@example.test`;
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
            return { id, cookie: sessionCookieHeader(cookie), name };
          }

          const alex = await signUp('Alex');
          const jamie = await signUp('Jamie');
          const taylor = await signUp('Taylor');
          const other = await signUp('Morgan');
          const ended = await signUp('Ended');

          const homeA = createUuidV7();
          const homeB = createUuidV7();
          const archivedHome = createUuidV7();
          homeIds.push(homeA, homeB, archivedHome);
          const alexMembership = createUuidV7();
          const jamieMembership = createUuidV7();
          const taylorMembership = createUuidV7();
          const endedMembership = createUuidV7();
          const archivedMembership = createUuidV7();
          const otherMembership = createUuidV7();
          const removedSubject = createUuidV7();
          const historicalActor = createUuidV7();
          const anonymousUser = createUuidV7();
          const anonymousMembership = createUuidV7();

          await insertHome(database.pool, { id: homeA, name: 'Home A' });
          await insertHome(database.pool, { id: homeB, name: 'Home B' });
          await insertHome(database.pool, {
            id: archivedHome,
            name: 'Archived',
            archived: true,
          });
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
            id: endedMembership,
            homeId: homeA,
            userId: ended.id,
            role: 'ROOMMATE',
            ended: true,
          });
          await insertMembership(database.pool, {
            id: archivedMembership,
            homeId: archivedHome,
            userId: alex.id,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: otherMembership,
            homeId: homeB,
            userId: other.id,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: historicalActor,
            homeId: homeA,
            userId: ended.id,
            role: 'ROOMMATE',
            ended: true,
          });
          await database.pool.query(
            'INSERT INTO users (id, updated_at) VALUES ($1, NOW())',
            [anonymousUser],
          );
          identityIds.push(anonymousUser);
          await insertMembership(database.pool, {
            id: anonymousMembership,
            homeId: homeA,
            userId: anonymousUser,
            role: 'ROOMMATE',
            ended: true,
          });
          await insertMembership(database.pool, {
            id: removedSubject,
            homeId: homeA,
            userId: other.id,
            role: 'ROOMMATE',
            ended: true,
            endedByMembershipId: taylorMembership,
          });

          const unauthenticated = await request({
            method: 'GET',
            path: `/api/v1/homes/${homeA}/activity`,
          });
          assert.deepEqual(errorShape(unauthenticated), {
            status: 401,
            code: 'UNAUTHENTICATED',
            message: 'Authentication required',
          });
          assert.equal(
            unauthenticated.headers.get('cache-control'),
            'private, no-store',
          );

          const endedRes = await request({
            method: 'GET',
            path: `/api/v1/homes/${homeA}/activity`,
            headers: { Cookie: ended.cookie },
          });
          assert.deepEqual(errorShape(endedRes), {
            status: 404,
            code: 'NOT_FOUND',
            message: 'Not found',
          });
          assert.equal(
            endedRes.headers.get('cache-control'),
            'private, no-store',
          );

          const crossHome = await request({
            method: 'GET',
            path: `/api/v1/homes/${homeA}/activity`,
            headers: { Cookie: other.cookie },
          });
          assert.deepEqual(errorShape(crossHome), {
            status: 404,
            code: 'NOT_FOUND',
            message: 'Not found',
          });

          const archived = await request({
            method: 'GET',
            path: `/api/v1/homes/${archivedHome}/activity`,
            headers: { Cookie: alex.cookie },
          });
          assert.deepEqual(errorShape(archived), {
            status: 404,
            code: 'NOT_FOUND',
            message: 'Not found',
          });

          const T = (ms: number) =>
            new Date(Date.UTC(2026, 8, 13, 21, 0, 0, ms));
          const H1 = createUuidV7();
          const A1 = createUuidV7();
          const J1 = createUuidV7();
          const H2 = createUuidV7();
          const A2 = createUuidV7();
          const J2 = createUuidV7();
          const H3 = createUuidV7();
          const taskId = createUuidV7();
          const supplyId = createUuidV7();
          const householdId = createUuidV7();
          const privateId = createUuidV7();
          const startedId = createUuidV7();
          const endedId = createUuidV7();
          const roleId = createUuidV7();
          const historicalId = createUuidV7();
          const removedId = createUuidV7();
          const anonymousId = createUuidV7();
          const activities = createActivityRepository(database.pool);
          const maintenance = createMaintenanceRepository(database.pool);

          await database.pool.query(
            `INSERT INTO task_instances (
               id, home_id, source, status, title, scheduled_for,
               assigned_membership_id, task_definition_id, completed_at,
               completed_by_membership_id, created_at, updated_at
             ) VALUES (
               $1::uuid, $2::uuid, 'MANUAL', 'COMPLETED', $3, NULL, NULL,
               NULL, $4::timestamptz, $5::uuid, $4::timestamptz, $4::timestamptz
             )`,
            [taskId, homeA, 'Take out trash', T(50), alexMembership],
          );
          await database.pool.query(
            `INSERT INTO supply_entries (
               id, home_id, title, status, created_by_membership_id,
               obtained_at, obtained_by_membership_id, canceled_at,
               created_at, updated_at
             ) VALUES (
               $1::uuid, $2::uuid, $3, 'OBTAINED', $4::uuid,
               $5::timestamptz, $4::uuid, NULL, $5::timestamptz, $5::timestamptz
             )`,
            [supplyId, homeA, 'Milk', alexMembership, T(40)],
          );
          await runInReadCommittedTransaction(database.pool, async (tx) => {
            await maintenance.insertEntryWithAudience(tx, {
              entry: {
                id: householdId,
                homeId: homeA,
                createdByMembershipId: alexMembership,
                visibility: 'HOUSEHOLD',
                title: 'Household leak',
                details: HOUSEHOLD_DETAILS,
                status: 'OPEN',
                resolvedByMembershipId: null,
                resolvedAt: null,
                createdAt: CREATED,
                updatedAt: CREATED,
              },
              audienceMembershipIds: [],
            });
            await maintenance.insertEntryWithAudience(tx, {
              entry: {
                id: privateId,
                homeId: homeA,
                createdByMembershipId: alexMembership,
                visibility: 'PRIVATE',
                title: PRIVATE_TITLE,
                details: PRIVATE_DETAILS,
                status: 'OPEN',
                resolvedByMembershipId: null,
                resolvedAt: null,
                createdAt: CREATED,
                updatedAt: CREATED,
              },
              audienceMembershipIds: [alexMembership],
            });
            await activities.insertHomeVisibleActivity(
              tx,
              activityInput(H1, homeA, T(700), {
                actorMembershipId: taylorMembership,
              }),
            );
            await activities.insertSourceAuthorizedActivity(
              tx,
              activityInput(A1, homeA, T(600), {
                sourceEntityType: 'MAINTENANCE',
                sourceEntityId: privateId,
                eventType: 'maintenance.created.v1',
                actorMembershipId: alexMembership,
              }),
              [alexMembership],
            );
            await activities.insertSourceAuthorizedActivity(
              tx,
              activityInput(J1, homeA, T(500)),
              [jamieMembership],
            );
            await activities.insertHomeVisibleActivity(
              tx,
              activityInput(H2, homeA, T(400), {
                actorMembershipId: taylorMembership,
              }),
            );
            await activities.insertSourceAuthorizedActivity(
              tx,
              activityInput(A2, homeA, T(300)),
              [alexMembership],
            );
            await activities.insertSourceAuthorizedActivity(
              tx,
              activityInput(J2, homeA, T(200)),
              [jamieMembership],
            );
            await activities.insertHomeVisibleActivity(
              tx,
              activityInput(H3, homeA, T(100), {
                actorMembershipId: taylorMembership,
              }),
            );
            await activities.insertHomeVisibleActivity(
              tx,
              activityInput(startedId, homeA, T(90), {
                sourceEntityType: 'MEMBERSHIP',
                sourceEntityId: jamieMembership,
                eventType: 'membership.started.v1',
                actorMembershipId: jamieMembership,
              }),
            );
            await activities.insertHomeVisibleActivity(
              tx,
              activityInput(endedId, homeA, T(80), {
                sourceEntityType: 'MEMBERSHIP',
                sourceEntityId: removedSubject,
                eventType: 'membership.ended.v1',
                actorMembershipId: taylorMembership,
              }),
            );
            await activities.insertHomeVisibleActivity(
              tx,
              activityInput(roleId, homeA, T(70), {
                sourceEntityType: 'MEMBERSHIP',
                sourceEntityId: jamieMembership,
                eventType: 'membership.role_changed.v1',
                actorMembershipId: taylorMembership,
              }),
            );
            await activities.insertHomeVisibleActivity(
              tx,
              activityInput(taskId, homeA, T(60), {
                sourceEntityType: 'TASK',
                sourceEntityId: taskId,
                eventType: 'task.completed.v1',
                actorMembershipId: historicalActor,
              }),
            );
            await activities.insertHomeVisibleActivity(
              tx,
              activityInput(supplyId, homeA, T(50), {
                sourceEntityType: 'SUPPLY',
                sourceEntityId: supplyId,
                eventType: 'supply.obtained.v1',
                actorMembershipId: alexMembership,
              }),
            );
            await activities.insertHomeVisibleActivity(
              tx,
              activityInput(householdId, homeA, T(45), {
                sourceEntityType: 'MAINTENANCE',
                sourceEntityId: householdId,
                eventType: 'maintenance.created.v1',
                actorMembershipId: alexMembership,
              }),
            );
            await activities.insertHomeVisibleActivity(
              tx,
              activityInput(historicalId, homeA, T(30), {
                actorMembershipId: historicalActor,
              }),
            );
            await activities.insertHomeVisibleActivity(
              tx,
              activityInput(removedId, homeA, T(20), {
                sourceEntityType: 'MEMBERSHIP',
                sourceEntityId: removedSubject,
                eventType: 'membership.ended.v1',
                actorMembershipId: taylorMembership,
              }),
            );
            await activities.insertHomeVisibleActivity(
              tx,
              activityInput(anonymousId, homeA, T(10), {
                actorMembershipId: anonymousMembership,
              }),
            );
          });

          async function listAll(cookie: string, homeId = homeA, limit = 20) {
            const ids: string[] = [];
            let cursor: string | undefined;
            let lastHasMore = false;
            for (let i = 0; i < 20; i += 1) {
              const query = new URLSearchParams({ limit: String(limit) });
              if (cursor !== undefined) {
                query.set('cursor', cursor);
              }
              const res = await request({
                method: 'GET',
                path: `/api/v1/homes/${homeId}/activity?${query.toString()}`,
                headers: { Cookie: cookie },
              });
              assert.equal(res.status, 200);
              assert.equal(
                res.headers.get('cache-control'),
                'private, no-store',
              );
              const body = activityListPageDtoSchema.parse(res.json());
              assertNoForbiddenLeak({
                context: 'activity list page',
                text: res.text,
                forbidden: [...leakSentinels, PRIVATE_TITLE],
              });
              ids.push(...body.items.map((item) => item.id));
              lastHasMore = body.hasMore;
              if (!body.hasMore) {
                assert.equal(body.nextCursor, null);
                break;
              }
              assert.ok(body.nextCursor);
              cursor = body.nextCursor;
            }
            return { ids, lastHasMore };
          }

          const alexFeed = await listAll(alex.cookie, homeA, 2);
          const jamieFeed = await listAll(jamie.cookie, homeA, 2);
          const taylorFeed = await listAll(taylor.cookie, homeA, 2);
          assert.deepEqual(alexFeed.ids.slice(0, 5), [H1, A1, H2, A2, H3]);
          assert.deepEqual(jamieFeed.ids.slice(0, 5), [H1, J1, H2, J2, H3]);
          assert.deepEqual(taylorFeed.ids.slice(0, 3), [H1, H2, H3]);
          assert.equal(taylorFeed.ids.includes(A1), false);
          assert.equal(taylorFeed.ids.includes(A2), false);
          assert.equal(taylorFeed.ids.includes(J1), false);
          assert.equal(new Set(alexFeed.ids).size, alexFeed.ids.length);

          const taylorFull = await request({
            method: 'GET',
            path: `/api/v1/homes/${homeA}/activity?limit=100`,
            headers: { Cookie: taylor.cookie },
          });
          const taylorBody = activityListPageDtoSchema.parse(taylorFull.json());
          assert.equal(
            taylorBody.items.some((item) => item.id === A1 || item.id === J1),
            false,
          );
          const householdItem = taylorBody.items.find(
            (item) => item.id === householdId,
          );
          assert.ok(householdItem);
          assert.equal(householdItem.sourceTitle, 'Household leak');
          assert.equal(householdItem.eventType, 'maintenance.created.v1');
          const privateItem = taylorBody.items.find((item) => item.id === A1);
          assert.equal(privateItem, undefined);
          const taskItem = taylorBody.items.find((item) => item.id === taskId);
          assert.ok(taskItem);
          assert.equal(taskItem.sourceTitle, 'Take out trash');
          assert.equal(taskItem.actor?.membershipId, historicalActor);
          assert.equal(taskItem.actor?.name, 'Ended');
          const supplyItem = taylorBody.items.find(
            (item) => item.id === supplyId,
          );
          assert.ok(supplyItem);
          assert.equal(supplyItem.sourceTitle, 'Milk');
          const started = taylorBody.items.find(
            (item) => item.id === startedId,
          );
          assert.ok(started);
          assert.equal(started.subject?.name, 'Jamie');
          assert.equal(started.actor?.membershipId, jamieMembership);
          const role = taylorBody.items.find((item) => item.id === roleId);
          assert.ok(role);
          assert.equal(role.actor?.membershipId, taylorMembership);
          assert.equal(role.subject?.membershipId, jamieMembership);
          assert.equal('oldRole' in role, false);
          const removed = taylorBody.items.find(
            (item) => item.id === removedId,
          );
          assert.ok(removed);
          assert.equal(removed.actor?.membershipId, taylorMembership);
          assert.equal(removed.subject?.membershipId, removedSubject);
          assert.notEqual(
            removed.actor?.membershipId,
            removed.subject?.membershipId,
          );
          const anonymous = taylorBody.items.find(
            (item) => item.id === anonymousId,
          );
          assert.ok(anonymous);
          assert.equal(anonymous.actor?.membershipId, anonymousMembership);
          assert.equal(anonymous.actor?.name, null);

          const alexPrivate = await request({
            method: 'GET',
            path: `/api/v1/homes/${homeA}/activity?limit=100`,
            headers: { Cookie: alex.cookie },
          });
          const alexBody = activityListPageDtoSchema.parse(alexPrivate.json());
          const alexPrivateItem = alexBody.items.find((item) => item.id === A1);
          assert.ok(alexPrivateItem);
          assert.equal(alexPrivateItem.sourceTitle, null);
          assert.equal(alexPrivateItem.eventType, 'maintenance.created.v1');
          assert.equal(JSON.stringify(alexBody).includes(PRIVATE_TITLE), false);
          assert.equal(
            JSON.stringify(alexBody).includes(PRIVATE_DETAILS),
            false,
          );

          const homeAFirst = await request({
            method: 'GET',
            path: `/api/v1/homes/${homeA}/activity?limit=2`,
            headers: { Cookie: taylor.cookie },
          });
          const homeAPage = activityListPageDtoSchema.parse(homeAFirst.json());
          assert.ok(homeAPage.nextCursor);
          const crossCursor = await request({
            method: 'GET',
            path: `/api/v1/homes/${homeB}/activity?limit=2&cursor=${encodeURIComponent(homeAPage.nextCursor)}`,
            headers: { Cookie: other.cookie },
          });
          assert.deepEqual(errorShape(crossCursor), {
            status: 400,
            code: 'INVALID_REQUEST',
            message: 'Invalid request',
          });
          assert.equal(crossCursor.text.includes(homeAPage.nextCursor), false);

          const forged = encodeActivityListCursor({
            v: 1,
            occurredAt: T(700).toISOString(),
            id: H1,
            homeId: homeB,
            actorMembershipId: otherMembership,
            queryFingerprint: ACTIVITY_LIST_QUERY_FINGERPRINT,
          });
          const forgedRes = await request({
            method: 'GET',
            path: `/api/v1/homes/${homeA}/activity?cursor=${encodeURIComponent(forged)}`,
            headers: { Cookie: alex.cookie },
          });
          assert.deepEqual(errorShape(forgedRes), {
            status: 400,
            code: 'INVALID_REQUEST',
            message: 'Invalid request',
          });

          const malformed = await request({
            method: 'GET',
            path: `/api/v1/homes/${homeA}/activity?cursor=${encodeURIComponent('%%%')}`,
            headers: { Cookie: alex.cookie },
          });
          assert.deepEqual(errorShape(malformed), {
            status: 400,
            code: 'INVALID_REQUEST',
            message: 'Invalid request',
          });
          assert.equal(malformed.text.includes('%%%'), false);

          await database.pool.query(
            `UPDATE memberships
             SET ended_at = NOW(), ended_by_membership_id = $2
             WHERE id = $1`,
            [alexMembership, alexMembership],
          );
          const alexB = createUuidV7();
          await insertMembership(database.pool, {
            id: alexB,
            homeId: homeA,
            userId: alex.id,
            role: 'ROOMMATE',
          });
          const rejoined = await request({
            method: 'GET',
            path: `/api/v1/homes/${homeA}/activity?limit=100`,
            headers: { Cookie: alex.cookie },
          });
          const rejoinedBody = activityListPageDtoSchema.parse(rejoined.json());
          assert.equal(
            rejoinedBody.items.some((item) => item.id === A1 || item.id === A2),
            false,
          );
          assert.ok(rejoinedBody.items.some((item) => item.id === H1));
          assert.ok(rejoinedBody.items.some((item) => item.id === taskId));
          const historicalAfterRejoin = rejoinedBody.items.find(
            (item) => item.id === taskId,
          );
          assert.equal(
            historicalAfterRejoin?.actor?.membershipId,
            historicalActor,
          );

          for (const haystack of [
            logs.join('\n'),
            unauthenticated.text,
            malformed.text,
          ]) {
            assertNoForbiddenLeak({
              context: 'activity logs or errors',
              text: haystack,
              forbidden: [
                ...leakSentinels,
                PRIVATE_TITLE,
                homeAPage.nextCursor ?? 'missing-cursor',
              ],
            });
          }
        });
      } finally {
        console.error = originalError;
        await cleanupHomes(database.pool, homeIds);
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
