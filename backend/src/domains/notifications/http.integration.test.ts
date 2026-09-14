import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createListCurrentUserNotificationsFromPool } from '../../application/notifications/list-current-user-notifications.js';
import { createMarkNotificationReadFromPool } from '../../application/notifications/mark-notification-read.js';
import { createReadAllNotificationsFromPool } from '../../application/notifications/read-all-notifications.js';
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
import { createMaintenanceRepository } from '../maintenance/repository.js';
import { notificationListPageDtoSchema } from './notification-dto.js';
import { NOTIFICATION_KIND_SOURCE_TYPE } from './notification.js';
import {
  createNotificationRepository,
  type NewNotification,
} from './repository.js';

const TEST_SECRET = 'roomies_test_secret_32_chars_minimum_value';
const TRUSTED_ORIGIN = 'http://127.0.0.1:5173';
const CANONICAL_FRONTEND_ORIGIN = 'http://localhost:5173';
const PASSWORD = 'test-password-only';
const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const CREATED = new Date('2026-09-13T12:00:00.000Z');
const PRIVATE_DETAILS = 'PRIVATE_MAINTENANCE_DETAILS_SENTINEL';
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
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO memberships (id, home_id, user_id, role, ended_at, ended_by_membership_id)
     VALUES ($1, $2, $3, $4, NULL, NULL)`,
    [input.id, input.homeId, input.userId, input.role],
  );
}

function row(
  homeId: string,
  recipientMembershipId: string,
  overrides: Partial<NewNotification> = {},
): NewNotification {
  const kind = overrides.kind ?? 'ASSIGNED_TASK_COMPLETED';
  return {
    id: overrides.id ?? createUuidV7(),
    homeId,
    recipientMembershipId,
    sourceOutboxEventId: overrides.sourceOutboxEventId ?? createUuidV7(),
    kind,
    sourceEntityType:
      overrides.sourceEntityType ?? NOTIFICATION_KIND_SOURCE_TYPE[kind],
    sourceEntityId: overrides.sourceEntityId ?? createUuidV7(),
    actorMembershipId:
      overrides.actorMembershipId === undefined
        ? null
        : overrides.actorMembershipId,
    occurredAt: overrides.occurredAt ?? CREATED,
    createdAt: overrides.createdAt ?? CREATED,
    readAt: overrides.readAt,
  };
}

async function cleanupHomes(pool: Pool, homeIds: string[]): Promise<void> {
  if (homeIds.length === 0) {
    return;
  }
  await pool.query(
    'DELETE FROM notifications WHERE home_id = ANY($1::uuid[])',
    [homeIds],
  );
  await pool.query(
    'DELETE FROM maintenance_audiences WHERE home_id = ANY($1)',
    [homeIds],
  );
  await pool.query('DELETE FROM maintenance_entries WHERE home_id = ANY($1)', [
    homeIds,
  ]);
  await pool.query('DELETE FROM supply_entries WHERE home_id = ANY($1)', [
    homeIds,
  ]);
  await pool.query('DELETE FROM task_instances WHERE home_id = ANY($1)', [
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
  PRIVATE_TITLE,
  'userId',
  'recipientMembershipId',
  'SELECT',
  'stack',
];

void describe('Notification HTTP PostgreSQL', () => {
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
    'authorizes the global list, presentation, mark-one, and read-all',
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
            notifications: {
              listCurrentUserNotifications:
                createListCurrentUserNotificationsFromPool(database.pool),
              markNotificationRead: createMarkNotificationReadFromPool(
                database.pool,
              ),
              readAllNotifications: createReadAllNotificationsFromPool(
                database.pool,
              ),
            },
          }),
        });

        await withAppServer(app, async (request) => {
          async function signUp(name: string) {
            const email = `m73-${name}-${randomUUID()}@example.test`;
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
            const cookie = findSessionSetCookie(signup.headers);
            assert.ok(cookie);
            return { id, cookie: sessionCookieHeader(cookie), name };
          }

          const alex = await signUp('Alex');
          const jamie = await signUp('Jamie');
          const taylor = await signUp('Taylor');
          const homeA = createUuidV7();
          const homeB = createUuidV7();
          homeIds.push(homeA, homeB);
          const alexA = createUuidV7();
          const alexB = createUuidV7();
          const jamieA = createUuidV7();
          const taylorA = createUuidV7();
          await insertHome(database.pool, { id: homeA, name: 'Home A' });
          await insertHome(database.pool, { id: homeB, name: 'Home B' });
          await insertMembership(database.pool, {
            id: alexA,
            homeId: homeA,
            userId: alex.id,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: alexB,
            homeId: homeB,
            userId: alex.id,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: jamieA,
            homeId: homeA,
            userId: jamie.id,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: taylorA,
            homeId: homeA,
            userId: taylor.id,
            role: 'ADMIN',
          });

          const taskId = createUuidV7();
          const supplyId = createUuidV7();
          const privateA = createUuidV7();
          const privateB = createUuidV7();
          const T = (ms: number) =>
            new Date(Date.UTC(2026, 8, 13, 21, 0, 0, ms));
          await database.pool.query(
            `INSERT INTO task_instances (
               id, home_id, source, status, title, scheduled_for,
               assigned_membership_id, task_definition_id, completed_at,
               completed_by_membership_id, created_at, updated_at
             ) VALUES (
               $1::uuid, $2::uuid, 'MANUAL', 'COMPLETED', $3, NULL, NULL,
               NULL, $4::timestamptz, $5::uuid, $4::timestamptz, $4::timestamptz
             )`,
            [taskId, homeA, 'Take out trash', T(50), alexA],
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
            [supplyId, homeB, 'Milk', alexB, T(40)],
          );
          const maintenance = createMaintenanceRepository(database.pool);
          await runInReadCommittedTransaction(database.pool, async (tx) => {
            await maintenance.insertEntryWithAudience(tx, {
              entry: {
                id: privateA,
                homeId: homeA,
                createdByMembershipId: alexA,
                visibility: 'PRIVATE',
                title: PRIVATE_TITLE,
                details: PRIVATE_DETAILS,
                status: 'OPEN',
                resolvedByMembershipId: null,
                resolvedAt: null,
                createdAt: CREATED,
                updatedAt: CREATED,
              },
              audienceMembershipIds: [alexA],
            });
            await maintenance.insertEntryWithAudience(tx, {
              entry: {
                id: privateB,
                homeId: homeA,
                createdByMembershipId: jamieA,
                visibility: 'PRIVATE',
                title: PRIVATE_TITLE,
                details: PRIVATE_DETAILS,
                status: 'OPEN',
                resolvedByMembershipId: null,
                resolvedAt: null,
                createdAt: CREATED,
                updatedAt: CREATED,
              },
              audienceMembershipIds: [jamieA],
            });
          });

          const notifications = createNotificationRepository(database.pool);
          const taskNote = row(homeA, alexA, {
            kind: 'ASSIGNED_TASK_COMPLETED',
            sourceEntityId: taskId,
            actorMembershipId: alexA,
            occurredAt: T(300),
          });
          const supplyNote = row(homeB, alexB, {
            kind: 'CREATED_SUPPLY_OBTAINED',
            sourceEntityId: supplyId,
            actorMembershipId: alexB,
            occurredAt: T(200),
          });
          const privateNoteA = row(homeA, alexA, {
            kind: 'PRIVATE_MAINTENANCE_CREATED',
            sourceEntityId: privateA,
            actorMembershipId: alexA,
            occurredAt: T(100),
          });
          const privateNoteB = row(homeA, jamieA, {
            kind: 'PRIVATE_MAINTENANCE_CREATED',
            sourceEntityId: privateB,
            actorMembershipId: jamieA,
            occurredAt: T(90),
          });
          await runInReadCommittedTransaction(database.pool, (tx) =>
            notifications.insertNotifications(tx, [
              taskNote,
              supplyNote,
              privateNoteA,
              privateNoteB,
            ]),
          );

          const unauthenticated = await request({
            method: 'GET',
            path: '/api/v1/notifications',
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

          const alexList = await request({
            method: 'GET',
            path: '/api/v1/notifications',
            headers: { Cookie: alex.cookie, Origin: TRUSTED_ORIGIN },
          });
          assert.equal(alexList.status, 200);
          assert.equal(
            alexList.headers.get('cache-control'),
            'private, no-store',
          );
          const alexBody = notificationListPageDtoSchema.parse(alexList.json());
          assert.equal('unreadCount' in alexBody, false);
          assert.deepEqual(
            alexBody.items.map((item) => item.id),
            [taskNote.id, supplyNote.id, privateNoteA.id],
          );
          assert.equal(alexBody.items[0]?.source?.type, 'TASK');
          assert.equal(alexBody.items[0]?.actor?.name, 'Alex');
          assert.equal(alexBody.items[1]?.source?.type, 'SUPPLY');
          assert.equal(alexBody.items[2]?.source, null);
          assert.deepEqual(alexBody.items[2]?.destination, {
            type: 'HOME',
            homeId: homeA,
          });
          assert.equal(alexList.text.includes(PRIVATE_TITLE), false);
          assert.equal(alexList.text.includes(PRIVATE_DETAILS), false);
          assert.equal(alexList.text.includes(privateA), false);
          assert.equal(alexList.text.includes(privateB), false);
          assert.equal(alexList.text.includes(jamie.id), false);

          const jamieList = await request({
            method: 'GET',
            path: '/api/v1/notifications',
            headers: { Cookie: jamie.cookie, Origin: TRUSTED_ORIGIN },
          });
          const jamieBody = notificationListPageDtoSchema.parse(
            jamieList.json(),
          );
          assert.deepEqual(
            jamieBody.items.map((item) => item.id),
            [privateNoteB.id],
          );
          assert.equal(jamieList.text.includes(privateNoteA.id), false);
          assert.equal(jamieList.text.includes(PRIVATE_TITLE), false);

          const taylorList = await request({
            method: 'GET',
            path: '/api/v1/notifications',
            headers: { Cookie: taylor.cookie, Origin: TRUSTED_ORIGIN },
          });
          const taylorBody = notificationListPageDtoSchema.parse(
            taylorList.json(),
          );
          assert.deepEqual(taylorBody.items, []);
          assert.equal(taylorList.text.includes(privateA), false);
          assert.equal(taylorList.text.includes(privateB), false);

          const mark = await request({
            method: 'POST',
            path: `/api/v1/notifications/${taskNote.id}/read`,
            headers: {
              Cookie: alex.cookie,
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: '{}',
          });
          assert.equal(mark.status, 204);
          assert.equal(mark.text, '');

          const otherMark = await request({
            method: 'POST',
            path: `/api/v1/notifications/${taskNote.id}/read`,
            headers: {
              Cookie: jamie.cookie,
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: '{}',
          });
          assert.deepEqual(errorShape(otherMark), {
            status: 404,
            code: 'NOT_FOUND',
            message: 'Not found',
          });
          assertNoForbiddenLeak({
            context: 'concealed mark-one',
            text: otherMark.text,
            forbidden: leakSentinels,
          });

          const readAll = await request({
            method: 'POST',
            path: '/api/v1/notifications/read-all',
            headers: {
              Cookie: alex.cookie,
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: '{}',
          });
          assert.equal(readAll.status, 204);
          assert.equal(readAll.text, '');
          assert.equal(readAll.text.includes('count'), false);

          const taylorReadAll = await request({
            method: 'POST',
            path: '/api/v1/notifications/read-all',
            headers: {
              Cookie: taylor.cookie,
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: '{}',
          });
          assert.equal(taylorReadAll.status, 204);
        });

        assertNoForbiddenLeak({
          context: 'notification http logs',
          text: logs.join('\n'),
          forbidden: [PRIVATE_TITLE, PRIVATE_DETAILS, 'audience'],
        });
      } finally {
        console.error = originalError;
        await cleanupHomes(database.pool, homeIds);
        await database.close();
      }
    },
  );
});
