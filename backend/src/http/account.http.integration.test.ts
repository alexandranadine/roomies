import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { createDeleteAccountLifecycleFromPool } from '../application/account/delete-account-lifecycle.js';
import {
  cleanupLifecycle,
  deferred,
  insertHome,
  insertMembership,
  insertPlainUser,
  testConfig,
  waitUntil,
  isWaitingForLock,
  backendPid,
} from '../application/account/delete-account-lifecycle.test-helpers.js';
import { createCanonicalUserDeletionMarkerPersistence } from '../domains/users/canonical-user-deletion-marker.js';
import {
  createCanonicalUserLookup,
  createPrincipalResolver,
} from '../platform/auth/principal.js';
import { createAuthRuntime } from '../platform/auth/runtime.js';
import { REQUEST_ID_HEADER } from '../platform/http/constants.js';
import { createApp } from '../platform/http/create-app.js';
import { withAppServer } from '../platform/http/app-request.test-helper.js';
import {
  assertNoForbiddenLeak,
  COMMON_SECRET_SENTINELS,
} from '../platform/http/assert-no-forbidden-leak.js';
import type { ApiErrorBody } from '../platform/http/errors.js';
import { createDatabasePool } from '../platform/persistence/pool.js';
import { createDbReadiness } from '../platform/persistence/readiness.js';
import {
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../platform/persistence/test-database.js';
import { createUuidV7 } from '../platform/ids/uuid-v7.js';
import { AuthInfrastructureError } from '../platform/auth/errors.js';
import { createDb } from '../prisma/db.js';
import { ACCOUNT_DELETION_FRESH_SESSION_MAX_AGE_MS } from './account-deletion-fresh-session.js';
import { createRoomiesApiRouter } from './create-roomies-api.js';

const PASSWORD = 'test-password-only';
const TRUSTED_ORIGIN = 'http://localhost:5173';
const HOSTILE_ORIGIN = 'https://evil.example';
const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();

function unusedHomeDependencies() {
  return {
    activeHomeActorResolver: {
      resolve: () =>
        Promise.reject(new Error('home actor resolver must not run')),
    },
    homeReader: {
      findActiveHomeById: () =>
        Promise.reject(new Error('home reader must not run')),
    },
    archiveFinalMemberHome: () =>
      Promise.reject(new Error('archive must not run')),
    changeMembershipRole: () =>
      Promise.reject(new Error('role change must not run')),
    leaveMembership: () => Promise.reject(new Error('leave must not run')),
    removeMembership: () => Promise.reject(new Error('remove must not run')),
  };
}

function findSessionSetCookie(headers: Headers): string | undefined {
  return headers
    .getSetCookie()
    .find((cookie) => /session_token=/i.test(cookie.split(';', 1)[0] ?? ''));
}

function sessionCookieHeader(setCookie: string): string {
  return setCookie.split(';', 1)[0] ?? '';
}

function cookieNameAndAttributes(setCookie: string): {
  name: string;
  value: string;
  attributes: string[];
} {
  const parts = setCookie.split(';').map((part) => part.trim());
  const pair = parts[0] ?? '';
  const separator = pair.indexOf('=');
  return {
    name: separator >= 0 ? pair.slice(0, separator) : pair,
    value: separator >= 0 ? pair.slice(separator + 1) : '',
    attributes: parts.slice(1).map((part) => part.toLowerCase()),
  };
}

function findExpiredSessionCookie(headers: Headers): string | undefined {
  return headers.getSetCookie().find((cookie) => {
    const parsed = cookieNameAndAttributes(cookie);
    return (
      /session_token/i.test(parsed.name) &&
      parsed.value === '' &&
      parsed.attributes.includes('max-age=0')
    );
  });
}

async function signUp(
  request: (options: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  }) => Promise<{
    status: number;
    headers: Headers;
    json: () => unknown;
  }>,
  name: string,
) {
  const email = `m87-${name}-${randomUUID()}@example.test`;
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
  const userId = (signup.json() as { user?: { id?: string } }).user?.id;
  assert.ok(userId);
  const setCookie = findSessionSetCookie(signup.headers);
  assert.ok(setCookie);
  return {
    userId,
    email,
    cookie: sessionCookieHeader(setCookie),
    setCookie,
  };
}

void describe('DELETE /api/v1/account HTTP integration', () => {
  void it(
    'deletes a legal account, expires the session cookie, then 401s /me',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const databaseUrl = resolveSafeDedicatedTestDatabaseUrl();
      const config = testConfig(databaseUrl);
      const database = createDatabasePool(config);
      const db = createDb(database.pool);
      const auth = createAuthRuntime(database.pool, config);
      const homeId = createUuidV7();
      const membershipId = createUuidV7();
      const adminMembershipId = createUuidV7();
      const adminUserId = randomUUID();
      const identityIds: string[] = [];

      try {
        await db.connect();
        await insertPlainUser(database.pool, adminUserId);
        const app = createApp({
          config,
          readiness: createDbReadiness(db),
          auth,
          roomiesApi: createRoomiesApiRouter({
            principalResolver: createPrincipalResolver({
              auth,
              hasCanonicalUser: createCanonicalUserLookup(database.pool),
            }),
            ...unusedHomeDependencies(),
            account: {
              deleteAccount: createDeleteAccountLifecycleFromPool(
                database.pool,
              ),
              auth,
            },
          }),
        });

        await withAppServer(app, async (request) => {
          const user = await signUp(request, 'legal');
          identityIds.push(user.userId);
          await insertHome(database.pool, homeId, 'Legal HTTP home');
          await insertMembership(database.pool, {
            id: membershipId,
            homeId,
            userId: user.userId,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: adminMembershipId,
            homeId,
            userId: adminUserId,
            role: 'ADMIN',
          });

          const deleted = await request({
            method: 'DELETE',
            path: '/api/v1/account',
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: user.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ confirmation: 'DELETE' }),
          });
          assert.equal(deleted.status, 204);
          assert.equal(deleted.text, '');
          const expired = findExpiredSessionCookie(deleted.headers);
          assert.ok(expired);
          const expiredAttrs = cookieNameAndAttributes(expired);
          const issuedAttrs = cookieNameAndAttributes(user.setCookie);
          assert.equal(expiredAttrs.name, issuedAttrs.name);
          assert.equal(expiredAttrs.value, '');
          assert.ok(expiredAttrs.attributes.includes('max-age=0'));
          assert.equal(expired.includes(issuedAttrs.value), false);

          const marker = await database.pool.query<{ deleted_at: Date | null }>(
            'SELECT deleted_at FROM users WHERE id = $1',
            [user.userId],
          );
          const identities = await database.pool.query(
            'SELECT id FROM auth_identities WHERE id = $1',
            [user.userId],
          );
          const sessions = await database.pool.query(
            'SELECT id FROM auth_sessions WHERE user_id = $1',
            [user.userId],
          );
          const membership = await database.pool.query<{
            ended_at: Date | null;
          }>('SELECT ended_at FROM memberships WHERE id = $1', [membershipId]);
          assert.ok(marker.rows[0]?.deleted_at);
          assert.equal(identities.rowCount, 0);
          assert.equal(sessions.rowCount, 0);
          assert.ok(membership.rows[0]?.ended_at);

          const me = await request({
            path: '/api/v1/me',
            headers: { Cookie: user.cookie },
          });
          assert.equal(me.status, 401);
          assert.equal(
            (me.json() as ApiErrorBody).error.code,
            'UNAUTHENTICATED',
          );
          assert.equal(me.text.includes('deleted'), false);
          assertNoForbiddenLeak({
            context: 'post-delete /me',
            text: me.text,
            forbidden: [
              ...COMMON_SECRET_SENTINELS,
              user.email,
              PASSWORD,
              issuedAttrs.value,
            ],
          });
        });
      } finally {
        await cleanupLifecycle(database.pool, {
          homeIds: [homeId],
          userIds: [...identityIds, adminUserId],
        });
        await db.close();
        await database.close();
      }
    },
  );

  void it(
    'blocks LAST_ADMIN_REQUIRED without expiring the session',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const databaseUrl = resolveSafeDedicatedTestDatabaseUrl();
      const config = testConfig(databaseUrl);
      const database = createDatabasePool(config);
      const db = createDb(database.pool);
      const auth = createAuthRuntime(database.pool, config);
      const homeId = createUuidV7();
      const adminMembershipId = createUuidV7();
      const roommateMembershipId = createUuidV7();
      const roommateUserId = randomUUID();
      const identityIds: string[] = [];

      try {
        await db.connect();
        await insertPlainUser(database.pool, roommateUserId);
        const app = createApp({
          config,
          readiness: createDbReadiness(db),
          auth,
          roomiesApi: createRoomiesApiRouter({
            principalResolver: createPrincipalResolver({
              auth,
              hasCanonicalUser: createCanonicalUserLookup(database.pool),
            }),
            ...unusedHomeDependencies(),
            account: {
              deleteAccount: createDeleteAccountLifecycleFromPool(
                database.pool,
              ),
              auth,
            },
          }),
        });

        await withAppServer(app, async (request) => {
          const admin = await signUp(request, 'last-admin');
          identityIds.push(admin.userId);
          await insertHome(database.pool, homeId, 'Blocked HTTP home');
          await insertMembership(database.pool, {
            id: adminMembershipId,
            homeId,
            userId: admin.userId,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: roommateMembershipId,
            homeId,
            userId: roommateUserId,
            role: 'ROOMMATE',
          });

          const blocked = await request({
            method: 'DELETE',
            path: '/api/v1/account',
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: admin.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ confirmation: 'DELETE' }),
          });
          assert.equal(blocked.status, 409);
          const body = blocked.json() as ApiErrorBody;
          assert.equal(body.error.code, 'LAST_ADMIN_REQUIRED');
          assert.equal(findExpiredSessionCookie(blocked.headers), undefined);
          assert.equal(blocked.text.includes(admin.email), false);

          const marker = await database.pool.query<{ deleted_at: Date | null }>(
            'SELECT deleted_at FROM users WHERE id = $1',
            [admin.userId],
          );
          const identities = await database.pool.query(
            'SELECT id FROM auth_identities WHERE id = $1',
            [admin.userId],
          );
          const sessions = await database.pool.query(
            'SELECT id FROM auth_sessions WHERE user_id = $1',
            [admin.userId],
          );
          const membership = await database.pool.query<{
            ended_at: Date | null;
          }>('SELECT ended_at FROM memberships WHERE id = $1', [
            adminMembershipId,
          ]);
          assert.equal(marker.rows[0]?.deleted_at, null);
          assert.equal(identities.rowCount, 1);
          assert.equal(sessions.rowCount, 1);
          assert.equal(membership.rows[0]?.ended_at, null);

          const me = await request({
            path: '/api/v1/me',
            headers: { Cookie: admin.cookie },
          });
          assert.equal(me.status, 200);
          assert.deepEqual(me.json(), { id: admin.userId });
        });
      } finally {
        await cleanupLifecycle(database.pool, {
          homeIds: [homeId],
          userIds: [...identityIds, roommateUserId],
        });
        await db.close();
        await database.close();
      }
    },
  );

  void it(
    'does not expire the cookie when lifecycle rolls back',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const databaseUrl = resolveSafeDedicatedTestDatabaseUrl();
      const config = testConfig(databaseUrl);
      const database = createDatabasePool(config);
      const db = createDb(database.pool);
      const auth = createAuthRuntime(database.pool, config);
      const homeId = createUuidV7();
      const membershipId = createUuidV7();
      const adminMembershipId = createUuidV7();
      const adminUserId = randomUUID();
      const identityIds: string[] = [];

      try {
        await db.connect();
        await insertPlainUser(database.pool, adminUserId);
        const app = createApp({
          config,
          readiness: createDbReadiness(db),
          auth,
          roomiesApi: createRoomiesApiRouter({
            principalResolver: createPrincipalResolver({
              auth,
              hasCanonicalUser: createCanonicalUserLookup(database.pool),
            }),
            ...unusedHomeDependencies(),
            account: {
              deleteAccount: createDeleteAccountLifecycleFromPool(
                database.pool,
                {
                  hooks: {
                    beforeCommit: () =>
                      Promise.reject(new AuthInfrastructureError()),
                  },
                },
              ),
              auth,
            },
          }),
        });

        await withAppServer(app, async (request) => {
          const user = await signUp(request, 'rollback');
          identityIds.push(user.userId);
          await insertHome(database.pool, homeId, 'Rollback HTTP home');
          await insertMembership(database.pool, {
            id: membershipId,
            homeId,
            userId: user.userId,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: adminMembershipId,
            homeId,
            userId: adminUserId,
            role: 'ADMIN',
          });

          const failed = await request({
            method: 'DELETE',
            path: '/api/v1/account',
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: user.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ confirmation: 'DELETE' }),
          });
          assert.equal(failed.status, 500);
          assert.equal(
            (failed.json() as ApiErrorBody).error.code,
            'INTERNAL_ERROR',
          );
          assert.equal(findExpiredSessionCookie(failed.headers), undefined);

          const marker = await database.pool.query<{ deleted_at: Date | null }>(
            'SELECT deleted_at FROM users WHERE id = $1',
            [user.userId],
          );
          const identities = await database.pool.query(
            'SELECT id FROM auth_identities WHERE id = $1',
            [user.userId],
          );
          assert.equal(marker.rows[0]?.deleted_at, null);
          assert.equal(identities.rowCount, 1);

          const me = await request({
            path: '/api/v1/me',
            headers: { Cookie: user.cookie },
          });
          assert.equal(me.status, 200);
          assert.deepEqual(me.json(), { id: user.userId });
        });
      } finally {
        await cleanupLifecycle(database.pool, {
          homeIds: [homeId],
          userIds: [...identityIds, adminUserId],
        });
        await db.close();
        await database.close();
      }
    },
  );

  void it(
    'returns 204 for two pre-authenticated concurrent deletes without duplicate events',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const databaseUrl = resolveSafeDedicatedTestDatabaseUrl();
      const config = testConfig(databaseUrl);
      const database = createDatabasePool(config);
      const db = createDb(database.pool);
      const auth = createAuthRuntime(database.pool, config);
      const homeId = createUuidV7();
      const membershipId = createUuidV7();
      const adminMembershipId = createUuidV7();
      const adminUserId = randomUUID();
      const identityIds: string[] = [];
      const firstLocked = deferred();
      const firstMayFinish = deferred();
      const secondPid = deferred<number>();
      const persistence = createCanonicalUserDeletionMarkerPersistence();
      let lockCount = 0;

      try {
        await db.connect();
        await insertPlainUser(database.pool, adminUserId);
        const app = createApp({
          config,
          readiness: createDbReadiness(db),
          auth,
          roomiesApi: createRoomiesApiRouter({
            principalResolver: createPrincipalResolver({
              auth,
              hasCanonicalUser: createCanonicalUserLookup(database.pool),
            }),
            ...unusedHomeDependencies(),
            account: {
              deleteAccount: createDeleteAccountLifecycleFromPool(
                database.pool,
                {
                  lockCanonicalUser: async (tx, userId) => {
                    lockCount += 1;
                    if (lockCount === 2) {
                      secondPid.resolve(await backendPid(tx));
                    }
                    return persistence.lockByUserId(tx, userId);
                  },
                  hooks: {
                    afterUserLocked: async () => {
                      if (lockCount === 1) {
                        firstLocked.resolve();
                        await firstMayFinish.promise;
                      }
                    },
                  },
                },
              ),
              auth,
            },
          }),
        });

        await withAppServer(app, async (request) => {
          const user = await signUp(request, 'race');
          identityIds.push(user.userId);
          await insertHome(database.pool, homeId, 'Race HTTP home');
          await insertMembership(database.pool, {
            id: membershipId,
            homeId,
            userId: user.userId,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: adminMembershipId,
            homeId,
            userId: adminUserId,
            role: 'ADMIN',
          });

          const headers = {
            Origin: TRUSTED_ORIGIN,
            Cookie: user.cookie,
            'content-type': 'application/json',
          };
          const body = JSON.stringify({ confirmation: 'DELETE' });
          const first = request({
            method: 'DELETE',
            path: '/api/v1/account',
            headers,
            body,
          });
          await firstLocked.promise;
          const second = request({
            method: 'DELETE',
            path: '/api/v1/account',
            headers,
            body,
          });
          const pid = await secondPid.promise;
          await waitUntil(() => isWaitingForLock(database.pool, pid));
          firstMayFinish.resolve();
          const [firstRes, secondRes] = await Promise.all([first, second]);
          assert.equal(firstRes.status, 204);
          assert.equal(secondRes.status, 204);
          assert.ok(findExpiredSessionCookie(firstRes.headers));
          assert.ok(findExpiredSessionCookie(secondRes.headers));

          const events = await database.pool.query<{ event_type: string }>(
            `SELECT event_type FROM outbox_events
             WHERE home_id = $1 AND event_type = 'membership.ended.v1'`,
            [homeId],
          );
          assert.equal(events.rowCount, 1);
        });
      } finally {
        firstMayFinish.resolve();
        await cleanupLifecycle(database.pool, {
          homeIds: [homeId],
          userIds: [...identityIds, adminUserId],
        });
        await db.close();
        await database.close();
      }
    },
  );

  void it(
    'rejects a deleted canonical User on /me without distinguishing identity',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const databaseUrl = resolveSafeDedicatedTestDatabaseUrl();
      const config = testConfig(databaseUrl);
      const database = createDatabasePool(config);
      const db = createDb(database.pool);
      const auth = createAuthRuntime(database.pool, config);
      const identityIds: string[] = [];
      const deletedAt = new Date('2026-09-15T18:00:00.000Z');

      try {
        await db.connect();
        const app = createApp({
          config,
          readiness: createDbReadiness(db),
          auth,
          roomiesApi: createRoomiesApiRouter({
            principalResolver: createPrincipalResolver({
              auth,
              hasCanonicalUser: createCanonicalUserLookup(database.pool),
            }),
            ...unusedHomeDependencies(),
          }),
        });

        await withAppServer(app, async (request) => {
          const unauthenticated = await request({ path: '/api/v1/me' });
          assert.equal(unauthenticated.status, 401);
          const unauthenticatedBody = unauthenticated.json() as ApiErrorBody;

          const user = await signUp(request, 'deleted-principal');
          identityIds.push(user.userId);
          const marked = await database.pool.query(
            `UPDATE users SET deleted_at = $1 WHERE id = $2 AND deleted_at IS NULL`,
            [deletedAt, user.userId],
          );
          assert.equal(marked.rowCount, 1);
          const identities = await database.pool.query(
            'SELECT id FROM auth_identities WHERE id = $1',
            [user.userId],
          );
          assert.equal(identities.rowCount, 1);

          const me = await request({
            path: '/api/v1/me',
            headers: { Cookie: user.cookie },
          });
          assert.equal(me.status, 401);
          const body = me.json() as ApiErrorBody;
          assert.equal(body.error.code, unauthenticatedBody.error.code);
          assert.equal(body.error.message, unauthenticatedBody.error.message);
          assert.equal(body.error.code, 'UNAUTHENTICATED');
          assert.equal(me.text.includes('deleted'), false);
          assert.equal(me.text.includes(user.email), false);
          assert.equal(me.headers.get(REQUEST_ID_HEADER), body.error.requestId);
        });
      } finally {
        await cleanupLifecycle(database.pool, {
          homeIds: [],
          userIds: identityIds,
        });
        await db.close();
        await database.close();
      }
    },
  );

  void it(
    'rejects stale and future session.createdAt before lifecycle',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const databaseUrl = resolveSafeDedicatedTestDatabaseUrl();
      const config = testConfig(databaseUrl);
      const database = createDatabasePool(config);
      const db = createDb(database.pool);
      const auth = createAuthRuntime(database.pool, config);
      const homeId = createUuidV7();
      const membershipId = createUuidV7();
      const adminMembershipId = createUuidV7();
      const adminUserId = randomUUID();
      const identityIds: string[] = [];
      let invoked = 0;
      const freshnessNow = new Date('2026-09-15T18:00:00.000Z');

      try {
        await db.connect();
        await insertPlainUser(database.pool, adminUserId);
        const app = createApp({
          config,
          readiness: createDbReadiness(db),
          auth,
          roomiesApi: createRoomiesApiRouter({
            principalResolver: createPrincipalResolver({
              auth,
              hasCanonicalUser: createCanonicalUserLookup(database.pool),
            }),
            ...unusedHomeDependencies(),
            account: {
              deleteAccount: async (input) => {
                invoked += 1;
                return createDeleteAccountLifecycleFromPool(database.pool)(
                  input,
                );
              },
              auth,
              clock: { now: () => freshnessNow },
            },
          }),
        });

        await withAppServer(app, async (request) => {
          const staleUser = await signUp(request, 'stale');
          identityIds.push(staleUser.userId);
          await insertHome(database.pool, homeId, 'Freshness HTTP home');
          await insertMembership(database.pool, {
            id: membershipId,
            homeId,
            userId: staleUser.userId,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: adminMembershipId,
            homeId,
            userId: adminUserId,
            role: 'ADMIN',
          });
          await database.pool.query(
            `UPDATE auth_sessions
             SET created_at = $2
             WHERE user_id = $1`,
            [
              staleUser.userId,
              new Date(
                freshnessNow.getTime() -
                  ACCOUNT_DELETION_FRESH_SESSION_MAX_AGE_MS -
                  1,
              ),
            ],
          );

          const stale = await request({
            method: 'DELETE',
            path: '/api/v1/account',
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: staleUser.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ confirmation: 'DELETE' }),
          });
          assert.equal(stale.status, 401);
          assert.equal(
            (stale.json() as ApiErrorBody).error.code,
            'UNAUTHENTICATED',
          );
          assert.equal(findExpiredSessionCookie(stale.headers), undefined);
          assert.equal(invoked, 0);
          assert.equal(stale.text.includes('createdAt'), false);

          const futureUser = await signUp(request, 'future');
          identityIds.push(futureUser.userId);
          await database.pool.query(
            `UPDATE auth_sessions
             SET created_at = $2
             WHERE user_id = $1`,
            [futureUser.userId, new Date(freshnessNow.getTime() + 60_000)],
          );
          const future = await request({
            method: 'DELETE',
            path: '/api/v1/account',
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: futureUser.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ confirmation: 'DELETE' }),
          });
          assert.equal(future.status, 401);
          assert.equal(invoked, 0);
          assert.equal(findExpiredSessionCookie(future.headers), undefined);

          await database.pool.query(
            `UPDATE auth_sessions
             SET created_at = $2
             WHERE user_id = $1`,
            [
              staleUser.userId,
              new Date(
                freshnessNow.getTime() -
                  ACCOUNT_DELETION_FRESH_SESSION_MAX_AGE_MS,
              ),
            ],
          );
          const exact = await request({
            method: 'DELETE',
            path: '/api/v1/account',
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: staleUser.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ confirmation: 'DELETE' }),
          });
          assert.equal(exact.status, 204);
          assert.equal(invoked, 1);
          assert.ok(findExpiredSessionCookie(exact.headers));
        });
      } finally {
        await cleanupLifecycle(database.pool, {
          homeIds: [homeId],
          userIds: [...identityIds, adminUserId],
        });
        await db.close();
        await database.close();
      }
    },
  );

  void it(
    'rejects a hostile Origin before lifecycle and does not expire the cookie',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const databaseUrl = resolveSafeDedicatedTestDatabaseUrl();
      const config = testConfig(databaseUrl);
      const database = createDatabasePool(config);
      const db = createDb(database.pool);
      const auth = createAuthRuntime(database.pool, config);
      const identityIds: string[] = [];
      let invoked = 0;

      try {
        await db.connect();
        const app = createApp({
          config,
          readiness: createDbReadiness(db),
          auth,
          roomiesApi: createRoomiesApiRouter({
            principalResolver: createPrincipalResolver({
              auth,
              hasCanonicalUser: createCanonicalUserLookup(database.pool),
            }),
            ...unusedHomeDependencies(),
            account: {
              deleteAccount: async (input) => {
                invoked += 1;
                return createDeleteAccountLifecycleFromPool(database.pool)(
                  input,
                );
              },
              auth,
            },
          }),
        });

        await withAppServer(app, async (request) => {
          const user = await signUp(request, 'origin');
          identityIds.push(user.userId);
          const hostile = await request({
            method: 'DELETE',
            path: '/api/v1/account',
            headers: {
              Origin: HOSTILE_ORIGIN,
              Cookie: user.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ confirmation: 'DELETE' }),
          });
          assert.equal(hostile.status, 403);
          assert.equal(
            (hostile.json() as ApiErrorBody).error.code,
            'FORBIDDEN',
          );
          assert.equal(findExpiredSessionCookie(hostile.headers), undefined);
          assert.equal(invoked, 0);
        });
      } finally {
        await cleanupLifecycle(database.pool, {
          homeIds: [],
          userIds: identityIds,
        });
        await db.close();
        await database.close();
      }
    },
  );
});
