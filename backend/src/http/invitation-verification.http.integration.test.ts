import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createAcceptInvitationFromPool } from '../application/invitations/accept-invitation.js';
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
  normalizeEmail,
} from '../platform/auth/index.js';
import { createAuthRuntime } from '../platform/auth/runtime.js';
import type { AppConfig } from '../platform/config/types.js';
import { createFakeTransactionalEmailSender } from '../platform/email/fake-sender.js';
import type { TransactionalEmailSender } from '../platform/email/types.js';
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
const TRUSTED_ORIGIN = 'http://localhost:5173';
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
    frontendOrigin: TRUSTED_ORIGIN,
    trustedOrigins: [TRUSTED_ORIGIN],
    trustProxyHops: 0,
    email: { provider: 'fake' },
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

function unusedHomeCommands() {
  return {
    archiveFinalMemberHome: () =>
      Promise.reject(new Error('archive must not run')),
    changeMembershipRole: () =>
      Promise.reject(new Error('role change must not run')),
    leaveMembership: () => Promise.reject(new Error('leave must not run')),
    removeMembership: () => Promise.reject(new Error('remove must not run')),
  };
}

async function insertHome(pool: Pool, id: string, name: string): Promise<void> {
  await pool.query(
    `INSERT INTO homes (id, name, timezone, updated_at)
     VALUES ($1, $2, 'UTC', NOW())`,
    [id, name],
  );
}

async function insertMembership(
  pool: Pool,
  input: { id: string; homeId: string; userId: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO memberships (id, home_id, user_id, role)
     VALUES ($1, $2, $3, 'ADMIN')`,
    [input.id, input.homeId, input.userId],
  );
}

void describe('signup → verification email → invitation acceptance', () => {
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
    'verifies email through Better Auth then accepts without a DB verified patch',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const databaseUrl = resolveSafeDedicatedTestDatabaseUrl();
      const config = authConfig(databaseUrl);
      const mailbox = createFakeTransactionalEmailSender();
      const database = createDatabasePool(config);
      const db = createDb(database.pool);
      const auth = createAuthRuntime(database.pool, config, {
        emailSender: mailbox,
      });
      const identityIds: string[] = [];
      const homeIds: string[] = [];
      const invitationIds: string[] = [];
      const secret = generateInvitationSecret();
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
            principalResolver: createPrincipalResolver({
              auth,
              hasCanonicalUser: createCanonicalUserLookup(database.pool),
            }),
            activeHomeActorResolver: createActiveHomeActorResolver(
              database.pool,
            ),
            homeReader: createHomeRepository(database.pool),
            ...unusedHomeCommands(),
            previewInvitation: createPreviewInvitationFromPool(database.pool),
            acceptInvitation: createAcceptInvitationFromPool(database.pool),
          }),
        });

        await withAppServer(app, async (request) => {
          async function signUp(name: string) {
            const email = `m94-${name}-${randomUUID()}@example.test`;
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
            assert.equal(
              cookie
                .toLowerCase()
                .split(';')
                .some((part) => part.trim().startsWith('domain=')),
              false,
            );
            return { id, email, cookie: sessionCookieHeader(cookie) };
          }

          const admin = await signUp('Admin');
          const invitee = await signUp('Invitee');

          const captured = mailbox.sent.find(
            (item) => item.to === normalizeEmail(invitee.email),
          );
          assert.ok(captured);
          const verificationUrl = new URL(captured.verificationUrl);
          assert.equal(
            verificationUrl.searchParams.get('callbackURL'),
            `${TRUSTED_ORIGIN}/verify-email`,
          );
          assert.equal(
            captured.text.includes(
              verificationUrl.searchParams.get('token') ?? '',
            ),
            true,
          );

          const before = await database.pool.query<{ email_verified: boolean }>(
            'SELECT email_verified FROM auth_identities WHERE id = $1',
            [invitee.id],
          );
          assert.equal(before.rows[0]?.email_verified, false);

          const verify = await request({
            path: `${verificationUrl.pathname}${verificationUrl.search}`,
            redirect: 'manual',
          });
          assert.equal(verify.status, 302);
          assert.equal(
            verify.headers.get('location'),
            `${TRUSTED_ORIGIN}/verify-email`,
          );

          const after = await database.pool.query<{ email_verified: boolean }>(
            'SELECT email_verified FROM auth_identities WHERE id = $1',
            [invitee.id],
          );
          assert.equal(after.rows[0]?.email_verified, true);

          const homeId = randomUUID();
          const membershipId = randomUUID();
          const invitationId = randomUUID();
          homeIds.push(homeId);
          invitationIds.push(invitationId);
          await insertHome(database.pool, homeId, 'Verification Home');
          await insertMembership(database.pool, {
            id: membershipId,
            homeId,
            userId: admin.id,
          });
          await database.pool.query(
            `INSERT INTO invitations (
               id, home_id, invited_email, token_hash, created_by_membership_id,
               created_at, expires_at
             ) VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', now() + interval '1 day')`,
            [
              invitationId,
              homeId,
              normalizeEmail(invitee.email),
              Buffer.from(hashInvitationSecretBytes(secret.bytes)),
              membershipId,
            ],
          );

          const accepted = await request({
            method: 'POST',
            path: `/api/v1/invitations/${invitationId}/accept`,
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: invitee.cookie,
              Authorization: `Invitation ${secret.encoded}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({}),
          });
          assert.equal(accepted.status, 201);
          const body = accepted.json() as {
            membershipId?: string;
            homeId?: string;
          };
          assert.equal(body.homeId, homeId);
          assert.ok(body.membershipId);

          const memberships = await database.pool.query(
            `SELECT id FROM memberships WHERE home_id = $1 AND user_id = $2 AND ended_at IS NULL`,
            [homeId, invitee.id],
          );
          assert.equal(memberships.rowCount, 1);

          assertNoForbiddenLeak({
            context: 'verification invitation logs',
            text: logs.join('\n'),
            forbidden: [
              ...COMMON_SECRET_SENTINELS,
              captured.verificationUrl,
              verificationUrl.searchParams.get('token') ?? 'missing-token',
              invitee.email,
              normalizeEmail(invitee.email),
              TEST_SECRET,
            ],
          });
        });
      } finally {
        console.error = originalError;
        if (invitationIds.length > 0) {
          await database.pool.query(
            'DELETE FROM invitations WHERE id = ANY($1::uuid[])',
            [invitationIds],
          );
        }
        if (homeIds.length > 0) {
          await database.pool.query(
            'DELETE FROM outbox_events WHERE home_id = ANY($1)',
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
    'refuses invitation acceptance while the Better Auth email is unverified',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const databaseUrl = resolveSafeDedicatedTestDatabaseUrl();
      const config = authConfig(databaseUrl);
      const mailbox = createFakeTransactionalEmailSender();
      const database = createDatabasePool(config);
      const db = createDb(database.pool);
      const auth = createAuthRuntime(database.pool, config, {
        emailSender: mailbox,
      });
      const identityIds: string[] = [];
      const homeIds: string[] = [];
      const invitationIds: string[] = [];
      const secret = generateInvitationSecret();

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
            activeHomeActorResolver: createActiveHomeActorResolver(
              database.pool,
            ),
            homeReader: createHomeRepository(database.pool),
            ...unusedHomeCommands(),
            previewInvitation: createPreviewInvitationFromPool(database.pool),
            acceptInvitation: createAcceptInvitationFromPool(database.pool),
          }),
        });

        await withAppServer(app, async (request) => {
          async function signUp(name: string) {
            const email = `m94-unverified-${name}-${randomUUID()}@example.test`;
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

          const admin = await signUp('Admin');
          const invitee = await signUp('Invitee');
          const verified = await database.pool.query<{
            email_verified: boolean;
          }>('SELECT email_verified FROM auth_identities WHERE id = $1', [
            invitee.id,
          ]);
          assert.equal(verified.rows[0]?.email_verified, false);

          const homeId = randomUUID();
          const membershipId = randomUUID();
          const invitationId = randomUUID();
          homeIds.push(homeId);
          invitationIds.push(invitationId);
          await insertHome(database.pool, homeId, 'Unverified Home');
          await insertMembership(database.pool, {
            id: membershipId,
            homeId,
            userId: admin.id,
          });
          await database.pool.query(
            `INSERT INTO invitations (
               id, home_id, invited_email, token_hash, created_by_membership_id,
               created_at, expires_at
             ) VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', now() + interval '1 day')`,
            [
              invitationId,
              homeId,
              normalizeEmail(invitee.email),
              Buffer.from(hashInvitationSecretBytes(secret.bytes)),
              membershipId,
            ],
          );

          const refused = await request({
            method: 'POST',
            path: `/api/v1/invitations/${invitationId}/accept`,
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: invitee.cookie,
              Authorization: `Invitation ${secret.encoded}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({}),
          });
          assert.equal(refused.status, 409);
          const body = refused.json() as ApiErrorBody;
          assert.equal(body.error.code, 'EMAIL_NOT_VERIFIED');
          const memberships = await database.pool.query(
            `SELECT id FROM memberships WHERE home_id = $1 AND user_id = $2`,
            [homeId, invitee.id],
          );
          assert.equal(memberships.rowCount, 0);
          assert.equal(refused.text.includes(invitee.email), false);
        });
      } finally {
        if (invitationIds.length > 0) {
          await database.pool.query(
            'DELETE FROM invitations WHERE id = ANY($1::uuid[])',
            [invitationIds],
          );
        }
        if (homeIds.length > 0) {
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
    'maps verification delivery failure without leaking provider or token material',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const databaseUrl = resolveSafeDedicatedTestDatabaseUrl();
      const config = authConfig(databaseUrl);
      let sends = 0;
      const sender: TransactionalEmailSender = {
        sendVerificationEmail() {
          sends += 1;
          if (sends === 1) {
            return Promise.resolve();
          }
          return Promise.reject(new Error('secret-provider-body token=abc'));
        },
        sendPasswordResetEmail() {
          return Promise.resolve();
        },
      };
      const database = createDatabasePool(config);
      const db = createDb(database.pool);
      const auth = createAuthRuntime(database.pool, config, {
        emailSender: sender,
      });
      const identityIds: string[] = [];
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
        });
        await withAppServer(app, async (request) => {
          const email = `m94-fail-${randomUUID()}@example.test`;
          const signup = await request({
            method: 'POST',
            path: '/api/auth/sign-up/email',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              name: 'Failing Mail',
              email,
              password: PASSWORD,
            }),
          });
          assert.ok(signup.status >= 200 && signup.status < 300);
          const id = (signup.json() as { user?: { id?: string } }).user?.id;
          assert.ok(id);
          identityIds.push(id);
          const cookie = findSessionSetCookie(signup.headers);
          assert.ok(cookie);

          const resend = await request({
            method: 'POST',
            path: '/api/auth/send-verification-email',
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: sessionCookieHeader(cookie),
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              email,
              callbackURL: `${TRUSTED_ORIGIN}/verify-email`,
            }),
          });
          assert.equal(resend.status, 500);
          assert.equal(resend.text.includes('secret-provider-body'), false);
          assert.equal(resend.text.includes(email), false);
          assert.equal(resend.text.includes('token=abc'), false);
          if (resend.text.startsWith('{')) {
            const body = resend.json() as ApiErrorBody;
            assert.equal(body.error.code, 'INTERNAL_ERROR');
          }
          assertNoForbiddenLeak({
            context: 'delivery failure logs',
            text: logs.join('\n'),
            forbidden: [
              ...COMMON_SECRET_SENTINELS,
              'secret-provider-body',
              email,
              'token=abc',
            ],
          });
        });
      } finally {
        console.error = originalError;
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
