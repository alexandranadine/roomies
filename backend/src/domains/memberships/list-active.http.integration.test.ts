import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createListActiveHomeMembershipsFromPool } from '../../application/memberships/list-active-home-memberships.js';
import { createHomeRepository } from '../homes/index.js';
import { createRoomiesApiRouter } from '../../http/create-roomies-api.js';
import {
  createCanonicalUserLookup,
  createPrincipalResolver,
} from '../../platform/auth/principal.js';
import { createAuthRuntime } from '../../platform/auth/runtime.js';
import type { AppConfig } from '../../platform/config/types.js';
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
import { createActiveHomeActorResolver } from './active-home-actor-resolver.js';
import type { ActiveHomeMembershipsDto } from './active-home-membership-dto.js';

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
    frontendOrigin: 'http://localhost:5173',
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

function listPath(homeId: string): string {
  return `/api/v1/homes/${homeId}/memberships`;
}

function concealedShape(body: ApiErrorBody): {
  statusCode: string;
  message: string;
} {
  return { statusCode: body.error.code, message: body.error.message };
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

async function insertPendingInvitation(
  pool: Pool,
  input: { id: string; homeId: string; email: string; createdBy: string },
): Promise<void> {
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO invitations (
       id, home_id, invited_email, token_hash, created_by_membership_id,
       created_at, expires_at, accepted_at, accepted_membership_id,
       revoked_at, revocation_cause
     ) VALUES (
       $1::uuid, $2::uuid, $3::text, $4::bytea, $5::uuid,
       $6::timestamptz, $7::timestamptz, NULL, NULL, NULL, NULL
     )`,
    [
      input.id,
      input.homeId,
      input.email,
      Buffer.from(new Uint8Array(32).fill(7)),
      input.createdBy,
      createdAt,
      expiresAt,
    ],
  );
}

void describe('GET /api/v1/homes/:homeId/memberships PostgreSQL', () => {
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
    'lists current active roommates with concealment, tenure, and cache policy',
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
            listActiveHomeMemberships: createListActiveHomeMembershipsFromPool(
              database.pool,
            ),
          }),
        });

        await withAppServer(app, async (request) => {
          async function signUp(name: string) {
            const email = `m55b0-${name}-${randomUUID()}@example.test`;
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

          async function listMemberships(input: {
            cookie: string;
            homeId: string;
          }) {
            return request({
              path: listPath(input.homeId),
              headers: { Cookie: input.cookie },
            });
          }

          const alex = await signUp('Alex');
          const jamie = await signUp('Jamie');
          const casey = await signUp('Casey');
          const drew = await signUp('Drew');
          const sam = await signUp('Sam');
          const taylor = await signUp('Taylor');
          const morgan = await signUp('Morgan');

          const homeA = randomUUID();
          const homeB = randomUUID();
          const archivedHome = randomUUID();
          const unknownHome = randomUUID();
          homeIds.push(homeA, homeB, archivedHome);

          const membershipAlex = randomUUID();
          const membershipJamie = randomUUID();
          const membershipCasey = randomUUID();
          const membershipDrewEnded = randomUUID();
          const membershipSamEnded = randomUUID();
          const membershipSamActive = randomUUID();
          const membershipTaylor = randomUUID();
          const membershipMorgan = randomUUID();
          const membershipArchived = randomUUID();
          const pendingInvitationId = randomUUID();
          const pendingEmail = `pending-${randomUUID()}@example.test`;

          await insertHome(database.pool, { id: homeA, name: 'Home A' });
          await insertHome(database.pool, { id: homeB, name: 'Home B' });
          await insertHome(database.pool, {
            id: archivedHome,
            name: 'Archived Home',
            archived: true,
          });

          await insertMembership(database.pool, {
            id: membershipAlex,
            homeId: homeA,
            userId: alex.id,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: membershipJamie,
            homeId: homeA,
            userId: jamie.id,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: membershipCasey,
            homeId: homeA,
            userId: casey.id,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: membershipDrewEnded,
            homeId: homeA,
            userId: drew.id,
            role: 'ROOMMATE',
            ended: true,
          });
          await insertMembership(database.pool, {
            id: membershipSamEnded,
            homeId: homeA,
            userId: sam.id,
            role: 'ROOMMATE',
            ended: true,
          });
          await insertMembership(database.pool, {
            id: membershipSamActive,
            homeId: homeA,
            userId: sam.id,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: membershipTaylor,
            homeId: homeB,
            userId: taylor.id,
            role: 'ADMIN',
          });
          await insertMembership(database.pool, {
            id: membershipMorgan,
            homeId: homeB,
            userId: morgan.id,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: membershipArchived,
            homeId: archivedHome,
            userId: alex.id,
            role: 'ROOMMATE',
          });
          await insertPendingInvitation(database.pool, {
            id: pendingInvitationId,
            homeId: homeA,
            email: pendingEmail,
            createdBy: membershipCasey,
          });

          const roommateList = await listMemberships({
            cookie: alex.cookie,
            homeId: homeA,
          });
          assert.equal(roommateList.status, 200);
          assert.equal(
            roommateList.headers.get('cache-control'),
            'private, no-store',
          );
          const roommateBody = roommateList.json() as ActiveHomeMembershipsDto;
          assert.equal(roommateBody.currentMembershipId, membershipAlex);
          assert.deepEqual(
            roommateBody.memberships.map((row) => row.name),
            ['Alex', 'Casey', 'Jamie', 'Sam'],
          );
          assert.deepEqual(
            roommateBody.memberships.map((row) => row.membershipId),
            [
              membershipAlex,
              membershipCasey,
              membershipJamie,
              membershipSamActive,
            ],
          );
          assert.deepEqual(Object.keys(roommateBody).sort(), [
            'currentMembershipId',
            'memberships',
          ]);
          assert.deepEqual(Object.keys(roommateBody.memberships[0]!).sort(), [
            'membershipId',
            'name',
          ]);
          assert.equal(
            roommateBody.memberships.some(
              (row) => row.membershipId === membershipSamEnded,
            ),
            false,
          );
          assert.equal(
            roommateBody.memberships.some(
              (row) => row.membershipId === membershipDrewEnded,
            ),
            false,
          );
          assert.equal(roommateList.text.includes(pendingEmail), false);
          assert.equal(roommateList.text.includes(pendingInvitationId), false);
          assert.equal(roommateList.text.includes(membershipTaylor), false);
          assert.equal(roommateList.text.includes(membershipMorgan), false);
          assert.equal(roommateList.text.includes('Taylor'), false);
          assert.equal(roommateList.text.includes('Morgan'), false);
          assert.equal(roommateList.text.includes(alex.email), false);
          assert.equal(roommateList.text.includes(jamie.email), false);
          assert.equal(roommateList.text.includes(alex.id), false);
          assertNoForbiddenLeak({
            context: 'active roommate list body',
            text: roommateList.text,
            forbidden: [
              ...COMMON_SECRET_SENTINELS,
              'userId',
              'endedAt',
              'joinedAt',
              'ROOMMATE',
              'ADMIN',
              'capabilities',
              'invitation',
              'session',
            ],
          });

          const adminList = await listMemberships({
            cookie: casey.cookie,
            homeId: homeA,
          });
          assert.equal(adminList.status, 200);
          const adminBody = adminList.json() as ActiveHomeMembershipsDto;
          assert.equal(adminBody.currentMembershipId, membershipCasey);
          assert.deepEqual(adminBody.memberships, roommateBody.memberships);

          const foreign = await listMemberships({
            cookie: alex.cookie,
            homeId: homeB,
          });
          assert.equal(foreign.status, 404);
          assert.deepEqual(concealedShape(foreign.json() as ApiErrorBody), {
            statusCode: 'NOT_FOUND',
            message: 'Not found',
          });

          const stale = await listMemberships({
            cookie: drew.cookie,
            homeId: homeA,
          });
          const archived = await listMemberships({
            cookie: alex.cookie,
            homeId: archivedHome,
          });
          const unknown = await listMemberships({
            cookie: alex.cookie,
            homeId: unknownHome,
          });
          const otherHomeCaller = await listMemberships({
            cookie: taylor.cookie,
            homeId: homeA,
          });

          for (const res of [
            foreign,
            stale,
            archived,
            unknown,
            otherHomeCaller,
          ]) {
            assert.equal(res.status, 404);
            assert.deepEqual(concealedShape(res.json() as ApiErrorBody), {
              statusCode: 'NOT_FOUND',
              message: 'Not found',
            });
            assert.equal(res.headers.get('cache-control'), 'private, no-store');
            assertNoForbiddenLeak({
              context: 'concealed membership list',
              text: res.text,
              forbidden: [
                ...COMMON_SECRET_SENTINELS,
                membershipAlex,
                membershipJamie,
                membershipCasey,
                membershipSamActive,
                membershipSamEnded,
                membershipTaylor,
                membershipMorgan,
                'Alex',
                'Jamie',
                'Casey',
                'Sam',
                'Taylor',
                'Morgan',
                'Drew',
                pendingEmail,
                alex.email,
                taylor.email,
                morgan.email,
                alex.id,
                taylor.id,
                morgan.id,
                'ROOMMATE',
                'ADMIN',
                'HOME_SCOPE_MISMATCH',
                'SELECT',
                'stack',
              ],
            });
          }

          assertNoForbiddenLeak({
            context: 'membership list logs',
            text: logs.join('\n'),
            forbidden: [
              ...COMMON_SECRET_SENTINELS,
              'Alex',
              'Jamie',
              'Casey',
              'Sam',
              'Taylor',
              'Morgan',
              'Drew',
              pendingEmail,
              alex.email,
              taylor.email,
              morgan.email,
              membershipTaylor,
              membershipMorgan,
            ],
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
