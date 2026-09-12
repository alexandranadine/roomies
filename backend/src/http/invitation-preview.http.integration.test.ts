import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createPreviewInvitationFromPool } from '../application/invitations/preview-invitation.js';
import { createHomeRepository } from '../domains/homes/index.js';
import {
  generateInvitationSecret,
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
import { invitationPreviewDtoSchema } from './invitation-preview.js';

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
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO memberships (id, home_id, user_id, role)
     VALUES ($1, $2, $3, $4)`,
    [input.id, input.homeId, input.userId, input.role],
  );
}

async function insertInvitation(
  pool: Pool,
  input: {
    id: string;
    homeId: string;
    email: string;
    createdByMembershipId: string;
    tokenHash: Uint8Array;
    createdAt: Date;
    expiresAt: Date;
    acceptedAt?: Date;
    acceptedMembershipId?: string;
    revokedAt?: Date;
    revocationCause?: 'ADMIN_REVOKED' | 'HOME_ARCHIVED';
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
      Buffer.from(input.tokenHash),
      input.createdByMembershipId,
      input.createdAt,
      input.expiresAt,
      input.acceptedAt ?? null,
      input.acceptedMembershipId ?? null,
      input.revokedAt ?? null,
      input.revocationCause ?? null,
    ],
  );
}

function assertUnavailable(res: {
  status: number;
  text: string;
  headers: Headers;
  json: () => unknown;
}): void {
  assert.equal(res.status, 404);
  const body = res.json() as ApiErrorBody;
  assert.equal(body.error.code, 'INVITATION_NOT_AVAILABLE');
  assert.equal(body.error.message, 'Invitation is not available');
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.equal(res.headers.get('etag'), null);
}

void describe('POST invitation preview HTTP PostgreSQL', () => {
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
    'covers pending preview, indistinguishable unavailability, Origin, and session isolation',
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
      const invitationIds: string[] = [];
      const logs: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        logs.push(args.map((value) => JSON.stringify(value)).join(' '));
      };

      const pendingSecret = generateInvitationSecret();
      const expiredSecret = generateInvitationSecret();
      const acceptedSecret = generateInvitationSecret();
      const revokedSecret = generateInvitationSecret();
      const otherSecret = generateInvitationSecret();
      const now = Date.now();
      const createdAt = new Date(now - 2 * 24 * 60 * 60 * 1000);
      const expiresAt = new Date(now + 5 * 24 * 60 * 60 * 1000);
      const expiredCreatedAt = new Date(now - 10 * 24 * 60 * 60 * 1000);
      const expiredExpiresAt = new Date(now - 3 * 24 * 60 * 60 * 1000);
      const terminalAt = new Date(now - 24 * 60 * 60 * 1000);

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
            previewInvitation: createPreviewInvitationFromPool(database.pool),
          }),
        });

        await withAppServer(app, async (request) => {
          async function signUp(name: string) {
            const email = `m22d-${name}-${randomUUID()}@example.test`;
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

          async function preview(input: {
            invitationId: string;
            secret?: string;
            origin?: string | null;
            cookie?: string;
            authorization?: string;
            body?: string;
          }) {
            const headers: Record<string, string> = {
              'content-type': 'application/json',
            };
            if (input.origin !== null) {
              headers.Origin = input.origin ?? TRUSTED_ORIGIN;
            }
            if (input.cookie) {
              headers.Cookie = input.cookie;
            }
            if (input.authorization !== undefined) {
              headers.Authorization = input.authorization;
            } else if (input.secret !== undefined) {
              headers.Authorization = `Invitation ${input.secret}`;
            }
            return request({
              method: 'POST',
              path: `/api/v1/invitations/${input.invitationId}/preview`,
              headers,
              body: input.body ?? JSON.stringify({}),
            });
          }

          const admin = await signUp('Admin');
          const roommate = await signUp('Roommate');
          const homeA = randomUUID();
          const homeB = randomUUID();
          homeIds.push(homeA, homeB);
          const membershipAdmin = randomUUID();
          const membershipHomeB = randomUUID();
          const membershipAccepted = randomUUID();
          await insertHome(database.pool, { id: homeA, name: 'Preview Home' });
          await insertHome(database.pool, { id: homeB, name: 'Other Home' });
          await insertMembership(database.pool, {
            id: membershipAdmin,
            homeId: homeA,
            userId: admin.id,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: membershipHomeB,
            homeId: homeB,
            userId: admin.id,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: membershipAccepted,
            homeId: homeA,
            userId: roommate.id,
            role: 'ROOMMATE',
          });

          const pendingId = randomUUID();
          const expiredId = randomUUID();
          const acceptedId = randomUUID();
          const revokedId = randomUUID();
          const otherId = randomUUID();
          const unknownId = randomUUID();
          invitationIds.push(
            pendingId,
            expiredId,
            acceptedId,
            revokedId,
            otherId,
          );

          await insertInvitation(database.pool, {
            id: pendingId,
            homeId: homeA,
            email: '  Invited.Roommate@Example.com ',
            createdByMembershipId: membershipAdmin,
            tokenHash: hashInvitationSecretBytes(pendingSecret.bytes),
            createdAt,
            expiresAt,
          });
          await insertInvitation(database.pool, {
            id: expiredId,
            homeId: homeA,
            email: 'expired@example.com',
            createdByMembershipId: membershipAdmin,
            tokenHash: hashInvitationSecretBytes(expiredSecret.bytes),
            createdAt: expiredCreatedAt,
            expiresAt: expiredExpiresAt,
          });
          await insertInvitation(database.pool, {
            id: acceptedId,
            homeId: homeA,
            email: 'accepted@example.com',
            createdByMembershipId: membershipAdmin,
            tokenHash: hashInvitationSecretBytes(acceptedSecret.bytes),
            createdAt,
            expiresAt,
            acceptedAt: terminalAt,
            acceptedMembershipId: membershipAccepted,
          });
          await insertInvitation(database.pool, {
            id: revokedId,
            homeId: homeA,
            email: 'revoked@example.com',
            createdByMembershipId: membershipAdmin,
            tokenHash: hashInvitationSecretBytes(revokedSecret.bytes),
            createdAt,
            expiresAt,
            revokedAt: terminalAt,
            revocationCause: 'ADMIN_REVOKED',
          });
          await insertInvitation(database.pool, {
            id: otherId,
            homeId: homeB,
            email: 'other@example.com',
            createdByMembershipId: membershipHomeB,
            tokenHash: hashInvitationSecretBytes(otherSecret.bytes),
            createdAt,
            expiresAt,
          });

          const signedOut = await preview({
            invitationId: pendingId,
            secret: pendingSecret.encoded,
          });
          assert.equal(signedOut.status, 200);
          assert.equal(
            signedOut.headers.get('cache-control'),
            'private, no-store',
          );
          assert.equal(signedOut.headers.get('etag'), null);
          const body = invitationPreviewDtoSchema.parse(signedOut.json());
          assert.deepEqual(Object.keys(body.invitation), [
            'id',
            'email',
            'expiresAt',
            'home',
          ]);
          assert.deepEqual(Object.keys(body.invitation.home), ['id', 'name']);
          assert.equal(body.invitation.id, pendingId);
          assert.equal(body.invitation.email, 'invited.roommate@example.com');
          assert.equal(body.invitation.expiresAt, expiresAt.toISOString());
          assert.equal(body.invitation.home.id, homeA);
          assert.equal(body.invitation.home.name, 'Preview Home');
          assert.equal('photo' in body.invitation.home, false);
          assert.equal('timezone' in body.invitation.home, false);
          assert.equal('tokenHash' in body.invitation, false);
          assert.equal('createdByMembershipId' in body.invitation, false);
          assert.equal(signedOut.text.includes(pendingSecret.encoded), false);
          assert.equal(signedOut.text.includes(admin.id), false);

          const signedIn = await preview({
            invitationId: pendingId,
            secret: pendingSecret.encoded,
            cookie: admin.cookie,
          });
          assert.equal(signedIn.status, 200);
          assert.deepEqual(signedIn.json(), signedOut.json());

          const unavailableCases = [
            await preview({
              invitationId: unknownId,
              secret: pendingSecret.encoded,
            }),
            await preview({
              invitationId: pendingId,
              secret: otherSecret.encoded,
            }),
            await preview({
              invitationId: pendingId,
              secret: 'not-a-32-byte-secret',
            }),
            await preview({ invitationId: pendingId }),
            await preview({
              invitationId: pendingId,
              authorization: `Bearer ${pendingSecret.encoded}`,
            }),
            await preview({
              invitationId: expiredId,
              secret: expiredSecret.encoded,
            }),
            await preview({
              invitationId: acceptedId,
              secret: acceptedSecret.encoded,
            }),
            await preview({
              invitationId: revokedId,
              secret: revokedSecret.encoded,
            }),
            await preview({
              invitationId: otherId,
              secret: pendingSecret.encoded,
            }),
            await preview({
              invitationId: pendingId,
              cookie: admin.cookie,
            }),
          ];

          const unavailableBodies = unavailableCases.map((res) => {
            assertUnavailable(res);
            return res.text;
          });
          assert.equal(
            new Set(
              unavailableBodies.map(
                (text) => (JSON.parse(text) as ApiErrorBody).error.code,
              ),
            ).size,
            1,
          );

          const hostile = await preview({
            invitationId: pendingId,
            secret: pendingSecret.encoded,
            origin: HOSTILE_ORIGIN,
          });
          assert.equal(hostile.status, 403);
          assert.equal(
            (hostile.json() as ApiErrorBody).error.code,
            'FORBIDDEN',
          );
          assert.equal(hostile.text.includes(HOSTILE_ORIGIN), false);
          assert.equal(hostile.text.includes(pendingSecret.encoded), false);

          const missingOrigin = await preview({
            invitationId: pendingId,
            secret: pendingSecret.encoded,
            origin: null,
          });
          assert.equal(missingOrigin.status, 403);
          assert.equal(
            (missingOrigin.json() as ApiErrorBody).error.code,
            'FORBIDDEN',
          );

          assertNoForbiddenLeak({
            context: 'preview HTTP bodies',
            text: [
              signedOut.text,
              signedIn.text,
              ...unavailableBodies,
              hostile.text,
              missingOrigin.text,
            ].join('\n'),
            forbidden: [
              ...COMMON_SECRET_SENTINELS,
              pendingSecret.encoded,
              expiredSecret.encoded,
              acceptedSecret.encoded,
              revokedSecret.encoded,
              otherSecret.encoded,
              'token_hash',
              'Authorization',
              membershipAdmin,
            ],
          });
          assertNoForbiddenLeak({
            context: 'preview HTTP logs',
            text: logs.join('\n'),
            forbidden: [
              pendingSecret.encoded,
              expiredSecret.encoded,
              acceptedSecret.encoded,
              revokedSecret.encoded,
              otherSecret.encoded,
              'Authorization',
              PASSWORD,
            ],
          });
        });
      } finally {
        console.error = originalError;
        await database.pool.query(
          'DELETE FROM invitations WHERE id = ANY($1::uuid[])',
          [invitationIds],
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
