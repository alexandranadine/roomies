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

void describe('POST invitation acceptance HTTP PostgreSQL', () => {
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
    'refuses acceptance as unauthenticated when the canonical User has deletedAt set',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const databaseUrl = resolveSafeDedicatedTestDatabaseUrl();
      const config = authConfig(databaseUrl);
      const database = createDatabasePool(config);
      const db = createDb(database.pool);
      const auth = createAuthRuntime(database.pool, config);
      const identityIds: string[] = [];
      const homeIds: string[] = [];
      const invitationIds: string[] = [];
      const deletedAt = new Date('2026-09-14T21:00:00.000Z');
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
            archiveFinalMemberHome: () =>
              Promise.reject(new Error('archive must not run')),
            changeMembershipRole: () =>
              Promise.reject(new Error('role change must not run')),
            leaveMembership: () =>
              Promise.reject(new Error('leave must not run')),
            removeMembership: () =>
              Promise.reject(new Error('remove must not run')),
            previewInvitation: createPreviewInvitationFromPool(database.pool),
            acceptInvitation: createAcceptInvitationFromPool(database.pool),
          }),
        });

        await withAppServer(app, async (request) => {
          async function signUp(name: string) {
            const email = `m82-accept-${name}-${randomUUID()}@example.test`;
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
          await database.pool.query(
            `UPDATE auth_identities SET email_verified = true WHERE id = $1`,
            [invitee.id],
          );

          const homeId = randomUUID();
          const membershipId = randomUUID();
          const invitationId = randomUUID();
          homeIds.push(homeId);
          invitationIds.push(invitationId);
          await insertHome(database.pool, homeId, 'Accept Lock Home');
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

          const preview = await request({
            method: 'POST',
            path: `/api/v1/invitations/${invitationId}/preview`,
            headers: {
              Origin: TRUSTED_ORIGIN,
              Authorization: `Invitation ${secret.encoded}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({}),
          });
          assert.equal(preview.status, 200);

          const marked = await database.pool.query(
            `UPDATE users SET deleted_at = $1 WHERE id = $2 AND deleted_at IS NULL`,
            [deletedAt, invitee.id],
          );
          assert.equal(marked.rowCount, 1);

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
          assert.equal(refused.status, 401);
          const body = refused.json() as ApiErrorBody;
          assert.equal(body.error.code, 'UNAUTHENTICATED');
          assert.equal(body.error.message, 'Authentication required');
          assert.equal(refused.text.includes('deleted'), false);
          assert.equal(refused.text.includes('deletedAt'), false);
          assert.equal(refused.text.includes(invitee.id), false);
          assertNoForbiddenLeak({
            context: 'deleted user invitation accept',
            text: refused.text,
            forbidden: [
              ...COMMON_SECRET_SENTINELS,
              invitee.email,
              secret.encoded,
              invitee.id,
              'deletedAt',
            ],
          });

          const invitation = await database.pool.query<{
            accepted_at: Date | null;
            accepted_membership_id: string | null;
          }>(
            `SELECT accepted_at, accepted_membership_id
             FROM invitations WHERE id = $1`,
            [invitationId],
          );
          const memberships = await database.pool.query(
            `SELECT id FROM memberships WHERE home_id = $1 AND user_id = $2`,
            [homeId, invitee.id],
          );
          const marker = await database.pool.query<{ deleted_at: Date | null }>(
            'SELECT deleted_at FROM users WHERE id = $1',
            [invitee.id],
          );
          assert.equal(invitation.rows[0]?.accepted_at, null);
          assert.equal(invitation.rows[0]?.accepted_membership_id, null);
          assert.equal(memberships.rowCount, 0);
          assert.equal(
            marker.rows[0]?.deleted_at?.getTime(),
            deletedAt.getTime(),
          );
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
});
