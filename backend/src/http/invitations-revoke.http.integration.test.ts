import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createCreateInvitationFromPool } from '../application/home-administration/create-invitation.js';
import { createRevokeInvitationFromPool } from '../application/home-administration/revoke-invitation.js';
import { createHomeRepository } from '../domains/homes/index.js';
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
    `INSERT INTO memberships (id, home_id, user_id, role)
     VALUES ($1, $2, $3, $4)`,
    [input.id, input.homeId, input.userId, input.role],
  );
}

async function insertInvitationRow(
  pool: Pool,
  input: {
    id: string;
    homeId: string;
    email: string;
    createdByMembershipId: string;
    createdAt: Date;
    expiresAt: Date;
    acceptedAt?: Date;
    acceptedMembershipId?: string;
    revokedAt?: Date;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO invitations (
       id, home_id, invited_email, token_hash, created_by_membership_id,
       created_at, expires_at, accepted_at, accepted_membership_id,
       revoked_at, revocation_cause
     ) VALUES (
       $1::uuid, $2::uuid, $3::text, $4::bytea, $5::uuid,
       $6::timestamptz, $7::timestamptz, $8::timestamptz, $9::uuid,
       $10::timestamptz, $11::text
     )`,
    [
      input.id,
      input.homeId,
      normalizeEmail(input.email),
      Buffer.from(randomBytes(32)),
      input.createdByMembershipId,
      input.createdAt,
      input.expiresAt,
      input.acceptedAt ?? null,
      input.acceptedMembershipId ?? null,
      input.revokedAt ?? null,
      input.revokedAt === undefined ? null : 'ADMIN_REVOKED',
    ],
  );
}

void describe('POST invitation revoke HTTP PostgreSQL', () => {
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
    'covers Admin 204, Roommate 403, unavailable, origin, and privacy',
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
              revokeInvitation: createRevokeInvitationFromPool(database.pool),
            },
          }),
        });

        await withAppServer(app, async (request) => {
          async function signUp(name: string) {
            const email = `m22f-${name}-${randomUUID()}@example.test`;
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

          async function revoke(input: {
            cookie?: string;
            homeId: string;
            invitationId: string;
            origin?: string;
            rawBody?: string;
            omitBody?: boolean;
          }) {
            const headers: Record<string, string> = {
              'content-type': 'application/json',
            };
            if (input.origin !== undefined) {
              headers.Origin = input.origin;
            } else if (input.origin !== null) {
              headers.Origin = TRUSTED_ORIGIN;
            }
            if (input.cookie !== undefined) {
              headers.Cookie = input.cookie;
            }
            if (input.origin === '') {
              delete headers.Origin;
            }
            return request({
              method: 'POST',
              path: `/api/v1/homes/${input.homeId}/invitations/${input.invitationId}/revoke`,
              headers,
              ...(input.omitBody === true
                ? {}
                : {
                    body: input.rawBody ?? JSON.stringify({}),
                  }),
            });
          }

          const admin = await signUp('Admin');
          const roommate = await signUp('Roommate');
          const otherAdmin = await signUp('OtherAdmin');

          const homeA = randomUUID();
          const homeB = randomUUID();
          homeIds.push(homeA, homeB);
          const membershipAdmin = randomUUID();
          const membershipRoommate = randomUUID();
          const membershipOther = randomUUID();

          await insertHome(database.pool, { id: homeA, name: 'Revoke Home A' });
          await insertHome(database.pool, { id: homeB, name: 'Revoke Home B' });
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
            id: membershipOther,
            homeId: homeB,
            userId: otherAdmin.id,
            role: 'ADMIN',
          });

          const created = await request({
            method: 'POST',
            path: `/api/v1/homes/${homeA}/invitations`,
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: admin.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              email: `m22f-pending-${randomUUID()}@example.test`,
            }),
          });
          assert.equal(created.status, 201);
          const invitationId = (
            created.json() as { invitation: { id: string } }
          ).invitation.id;
          const inviteUrl = (created.json() as { inviteUrl: string }).inviteUrl;
          const rawSecret = new URL(inviteUrl).hash.slice('#secret='.length);

          const unauthenticated = await revoke({
            homeId: homeA,
            invitationId,
          });
          assert.equal(unauthenticated.status, 401);
          assert.equal(
            (unauthenticated.json() as ApiErrorBody).error.code,
            'UNAUTHENTICATED',
          );

          const hostile = await revoke({
            cookie: admin.cookie,
            homeId: homeA,
            invitationId,
            origin: HOSTILE_ORIGIN,
          });
          assert.equal(hostile.status, 403);
          assert.equal(
            (hostile.json() as ApiErrorBody).error.code,
            'FORBIDDEN',
          );

          const missingOrigin = await revoke({
            cookie: admin.cookie,
            homeId: homeA,
            invitationId,
            origin: '',
          });
          assert.equal(missingOrigin.status, 403);
          assert.equal(
            (missingOrigin.json() as ApiErrorBody).error.code,
            'FORBIDDEN',
          );

          const roommateDenied = await revoke({
            cookie: roommate.cookie,
            homeId: homeA,
            invitationId,
          });
          assert.equal(roommateDenied.status, 403);
          assert.equal(
            (roommateDenied.json() as ApiErrorBody).error.code,
            'FORBIDDEN',
          );

          const stillPending = await database.pool.query<{
            revoked_at: Date | null;
          }>('SELECT revoked_at FROM invitations WHERE id = $1', [
            invitationId,
          ]);
          assert.equal(stillPending.rows[0]?.revoked_at, null);

          const success = await revoke({
            cookie: admin.cookie,
            homeId: homeA,
            invitationId,
            omitBody: true,
          });
          assert.equal(success.status, 204);
          assert.equal(success.text, '');
          assert.equal(
            success.headers.get('cache-control'),
            'private, no-store',
          );

          const revoked = await database.pool.query<{
            revoked_at: Date | null;
            revocation_cause: string | null;
            invited_email: string;
          }>(
            `SELECT revoked_at, revocation_cause, invited_email
             FROM invitations WHERE id = $1`,
            [invitationId],
          );
          assert.ok(revoked.rows[0]?.revoked_at instanceof Date);
          assert.equal(revoked.rows[0]?.revocation_cause, 'ADMIN_REVOKED');

          const already = await revoke({
            cookie: admin.cookie,
            homeId: homeA,
            invitationId,
          });
          assert.equal(already.status, 404);
          assert.equal(
            (already.json() as ApiErrorBody).error.code,
            'INVITATION_NOT_AVAILABLE',
          );

          const expiredId = randomUUID();
          const acceptedId = randomUUID();
          const foreignId = randomUUID();
          await insertInvitationRow(database.pool, {
            id: expiredId,
            homeId: homeA,
            email: `m22f-exp-${randomUUID()}@example.test`,
            createdByMembershipId: membershipAdmin,
            createdAt: new Date('2026-09-01T00:00:00.000Z'),
            expiresAt: new Date('2026-09-08T00:00:00.000Z'),
          });
          await insertInvitationRow(database.pool, {
            id: acceptedId,
            homeId: homeA,
            email: `m22f-acc-${randomUUID()}@example.test`,
            createdByMembershipId: membershipAdmin,
            createdAt: new Date('2026-10-01T00:00:00.000Z'),
            expiresAt: new Date('2026-10-08T00:00:00.000Z'),
            acceptedAt: new Date('2026-10-02T00:00:00.000Z'),
            acceptedMembershipId: membershipRoommate,
          });
          await insertInvitationRow(database.pool, {
            id: foreignId,
            homeId: homeB,
            email: `m22f-for-${randomUUID()}@example.test`,
            createdByMembershipId: membershipOther,
            createdAt: new Date('2026-10-01T00:00:00.000Z'),
            expiresAt: new Date('2026-10-08T00:00:00.000Z'),
          });

          for (const invitation of [expiredId, acceptedId, foreignId]) {
            const res = await revoke({
              cookie: admin.cookie,
              homeId: homeA,
              invitationId: invitation,
            });
            assert.equal(res.status, 404);
            assert.equal(
              (res.json() as ApiErrorBody).error.code,
              'INVITATION_NOT_AVAILABLE',
            );
            assertNoForbiddenLeak({
              context: 'revoke unavailable',
              text: res.text,
              forbidden: [
                ...COMMON_SECRET_SENTINELS,
                rawSecret,
                revoked.rows[0]?.invited_email ?? '',
                'token_hash',
                'tokenHash',
                homeB,
              ],
            });
          }

          const foreignUnchanged = await database.pool.query<{
            revoked_at: Date | null;
          }>('SELECT revoked_at FROM invitations WHERE id = $1', [foreignId]);
          assert.equal(foreignUnchanged.rows[0]?.revoked_at, null);

          const extraField = await revoke({
            cookie: admin.cookie,
            homeId: homeA,
            invitationId: expiredId,
            rawBody: JSON.stringify({ reason: 'nope' }),
          });
          assert.equal(extraField.status, 400);
          assert.equal(
            (extraField.json() as ApiErrorBody).error.code,
            'INVALID_REQUEST',
          );

          assertNoForbiddenLeak({
            context: 'revoke HTTP logs',
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
