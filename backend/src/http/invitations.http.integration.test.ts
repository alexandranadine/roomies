import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createCreateInvitationFromPool } from '../application/home-administration/create-invitation.js';
import { createHomeRepository } from '../domains/homes/index.js';
import {
  decodeInvitationSecret,
  hashInvitationSecretBytes,
} from '../domains/invitations/secret.js';
import { createActiveHomeActorResolver } from '../domains/memberships/index.js';
import {
  createCanonicalUserLookup,
  createPrincipalResolver,
} from '../platform/auth/principal.js';
import { createAuthRuntime } from '../platform/auth/runtime.js';
import { normalizeEmail } from '../platform/auth/index.js';
import type { AppConfig } from '../platform/config/types.js';
import { withAppServer } from '../platform/http/app-request.test-helper.js';
import {
  assertNoForbiddenLeak,
  COMMON_SECRET_SENTINELS,
} from '../platform/http/assert-no-forbidden-leak.js';
import { createApp } from '../platform/http/create-app.js';
import type { ApiErrorBody } from '../platform/http/errors.js';
import { createDatabasePool } from '../platform/persistence/pool.js';
import { createDbReadiness } from '../platform/persistence/readiness.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../platform/persistence/test-database.js';
import { createDb } from '../prisma/db.js';
import { createRoomiesApiRouter } from './create-roomies-api.js';
import { createdInvitationDtoSchema } from './invitations.js';

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

void describe('POST invitation HTTP PostgreSQL', () => {
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
    'covers Admin success, concealment, conflicts, and validation',
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
            invitations: {
              frontendOrigin: config.frontendOrigin,
              createInvitation: createCreateInvitationFromPool(database.pool),
            },
          }),
        });

        await withAppServer(app, async (request) => {
          async function signUp(name: string) {
            const email = `m22c-${name}-${randomUUID()}@example.test`;
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
            return { id, email, cookie: sessionCookieHeader(cookie) };
          }

          async function invite(input: {
            cookie: string;
            homeId: string;
            email: string;
            origin?: string;
            rawBody?: string;
          }) {
            return request({
              method: 'POST',
              path: `/api/v1/homes/${input.homeId}/invitations`,
              headers: {
                Origin: input.origin ?? TRUSTED_ORIGIN,
                Cookie: input.cookie,
                'content-type': 'application/json',
              },
              body: input.rawBody ?? JSON.stringify({ email: input.email }),
            });
          }

          const admin = await signUp('Admin');
          const roommate = await signUp('Roommate');
          const outsider = await signUp('Outsider');

          const homeA = randomUUID();
          const archivedHome = randomUUID();
          const missingHome = randomUUID();
          homeIds.push(homeA, archivedHome);

          const membershipAdmin = randomUUID();
          const membershipRoommate = randomUUID();
          const archivedMembership = randomUUID();

          await insertHome(database.pool, { id: homeA, name: 'Invite Home' });
          await insertHome(database.pool, {
            id: archivedHome,
            name: 'Archived',
            archived: true,
          });
          await insertMembership(database.pool, {
            id: membershipAdmin,
            homeId: homeA,
            userId: admin.id,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: membershipRoommate,
            homeId: homeA,
            userId: roommate.id,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: archivedMembership,
            homeId: archivedHome,
            userId: admin.id,
            role: 'ADMIN',
          });

          const created = await invite({
            cookie: admin.cookie,
            homeId: homeA,
            email: '  New.Roommate@Example.com ',
          });
          assert.equal(created.status, 201);
          const afterTrusted = await database.pool.query<{ count: string }>(
            `SELECT count(*)::text AS count
             FROM invitations
             WHERE home_id = $1`,
            [homeA],
          );
          assert.equal(afterTrusted.rows[0]?.count, '1');
          assert.equal(
            created.headers.get('cache-control'),
            'private, no-store',
          );
          const body = createdInvitationDtoSchema.parse(created.json());
          assert.equal(body.invitation.email, 'new.roommate@example.com');
          const inviteUrl = new URL(body.inviteUrl);
          assert.equal(inviteUrl.origin, CANONICAL_FRONTEND_ORIGIN);
          assert.notEqual(inviteUrl.origin, TRUSTED_ORIGIN);
          assert.equal(
            inviteUrl.pathname,
            `/invitations/${body.invitation.id}`,
          );
          assert.equal(inviteUrl.search, '');
          assert.match(inviteUrl.hash, /^#secret=/);
          const rawSecret = inviteUrl.hash.slice('#secret='.length);
          assert.ok(rawSecret.length > 0);
          assert.equal(JSON.stringify(body).includes('tokenHash'), false);

          const stored = await database.pool.query<{
            token_hash: Uint8Array;
            invited_email: string;
          }>(
            'SELECT token_hash, invited_email FROM invitations WHERE id = $1',
            [body.invitation.id],
          );
          assert.equal(
            stored.rows[0]?.invited_email,
            normalizeEmail('new.roommate@example.com'),
          );
          assert.deepEqual(
            [...(stored.rows[0]?.token_hash ?? [])],
            [...hashInvitationSecretBytes(decodeInvitationSecret(rawSecret))],
          );
          assert.equal(
            JSON.stringify(stored.rows[0]).includes(rawSecret),
            false,
          );

          const roommateDenied = await invite({
            cookie: roommate.cookie,
            homeId: homeA,
            email: `m22c-room-${randomUUID()}@example.test`,
          });
          assert.equal(roommateDenied.status, 403);
          assert.equal(
            (roommateDenied.json() as ApiErrorBody).error.code,
            'FORBIDDEN',
          );

          const outsiderDenied = await invite({
            cookie: outsider.cookie,
            homeId: homeA,
            email: `m22c-out-${randomUUID()}@example.test`,
          });
          assert.equal(outsiderDenied.status, 404);

          const archived = await invite({
            cookie: admin.cookie,
            homeId: archivedHome,
            email: `m22c-arch-${randomUUID()}@example.test`,
          });
          assert.equal(archived.status, 404);

          const missing = await invite({
            cookie: admin.cookie,
            homeId: missingHome,
            email: `m22c-miss-${randomUUID()}@example.test`,
          });
          assert.equal(missing.status, 404);

          const duplicate = await invite({
            cookie: admin.cookie,
            homeId: homeA,
            email: 'New.Roommate@Example.com',
          });
          assert.equal(duplicate.status, 409);
          assert.equal(
            (duplicate.json() as ApiErrorBody).error.code,
            'INVITATION_ALREADY_PENDING',
          );
          assert.equal(duplicate.text.includes(rawSecret), false);

          const alreadyMember = await invite({
            cookie: admin.cookie,
            homeId: homeA,
            email: roommate.email,
          });
          assert.equal(alreadyMember.status, 409);
          assert.equal(
            (alreadyMember.json() as ApiErrorBody).error.code,
            'ALREADY_HOME_MEMBER',
          );

          const malformed = await invite({
            cookie: admin.cookie,
            homeId: homeA,
            email: 'unused',
            rawBody: '{"email":',
          });
          assert.equal(malformed.status, 400);
          assert.equal(
            (malformed.json() as ApiErrorBody).error.code,
            'BAD_REQUEST',
          );

          const extraField = await invite({
            cookie: admin.cookie,
            homeId: homeA,
            email: 'unused',
            rawBody: JSON.stringify({
              email: 'extra@example.com',
              role: 'ADMIN',
            }),
          });
          assert.equal(extraField.status, 400);
          assert.equal(
            (extraField.json() as ApiErrorBody).error.code,
            'INVALID_REQUEST',
          );

          const hostileEmail = `m22c-hostile-${randomUUID()}@example.test`;
          const normalizedHostileEmail = normalizeEmail(hostileEmail);
          const beforeHostile = await database.pool.query<{ count: string }>(
            `SELECT count(*)::text AS count
             FROM invitations
             WHERE home_id = $1 AND invited_email = $2`,
            [homeA, normalizedHostileEmail],
          );
          assert.equal(beforeHostile.rows[0]?.count, '0');

          const hostile = await invite({
            cookie: admin.cookie,
            homeId: homeA,
            email: hostileEmail,
            origin: HOSTILE_ORIGIN,
          });
          assert.equal(hostile.status, 403);
          assert.equal(
            (hostile.json() as ApiErrorBody).error.code,
            'FORBIDDEN',
          );
          assert.equal(
            (hostile.json() as ApiErrorBody).error.message,
            'Forbidden',
          );
          assert.equal(
            hostile.headers.get('access-control-allow-origin'),
            null,
          );
          assert.equal('inviteUrl' in (hostile.json() as object), false);
          assert.equal(hostile.text.includes('#secret='), false);
          assert.equal(hostile.text.includes(HOSTILE_ORIGIN), false);
          assert.equal(hostile.text.includes(TRUSTED_ORIGIN), false);
          assert.equal(hostile.text.includes('TRUSTED_ORIGINS'), false);

          const missingOriginEmail = `m22c-missing-${randomUUID()}@example.test`;
          const missingOrigin = await request({
            method: 'POST',
            path: `/api/v1/homes/${homeA}/invitations`,
            headers: {
              Cookie: admin.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ email: missingOriginEmail }),
          });
          assert.equal(missingOrigin.status, 403);
          assert.equal(
            (missingOrigin.json() as ApiErrorBody).error.code,
            'FORBIDDEN',
          );

          const afterHostile = await database.pool.query<{ count: string }>(
            `SELECT count(*)::text AS count
             FROM invitations
             WHERE home_id = $1 AND invited_email = $2`,
            [homeA, normalizedHostileEmail],
          );
          assert.equal(afterHostile.rows[0]?.count, '0');
          const afterMissing = await database.pool.query<{ count: string }>(
            `SELECT count(*)::text AS count
             FROM invitations
             WHERE home_id = $1`,
            [homeA],
          );
          assert.equal(afterMissing.rows[0]?.count, '1');

          assertNoForbiddenLeak({
            context: 'invitation HTTP logs',
            text: logs.join('\n'),
            forbidden: [...COMMON_SECRET_SENTINELS, rawSecret, PASSWORD],
          });
        });
      } finally {
        console.error = originalError;
        await database.pool.query(
          'DELETE FROM invitations WHERE home_id = ANY($1::uuid[])',
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
