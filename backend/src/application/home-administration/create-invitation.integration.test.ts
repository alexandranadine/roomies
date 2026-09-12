import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { lockHomeStructure } from '../../domains/homes/lock-home-structure.js';
import { createChangeMembershipRole } from './change-membership-role.js';
import { createMembershipRoleWriter } from '../../domains/memberships/update-active-membership-role.js';
import {
  AlreadyHomeMemberError,
  InvitationAlreadyPendingError,
} from '../../domains/invitations/errors.js';
import { INVITATION_LIFETIME_MS } from '../../domains/invitations/invitation.js';
import { createInvitationRepository } from '../../domains/invitations/repository.js';
import {
  decodeInvitationSecret,
  generateInvitationSecret,
  hashInvitationSecretBytes,
} from '../../domains/invitations/secret.js';
import { findCanonicalIdentityByEmail } from '../../platform/auth/canonical-identity-by-email.js';
import { normalizeEmail } from '../../platform/auth/index.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  ForbiddenError,
} from '../../platform/authz/errors.js';
import type { AppConfig } from '../../platform/config/types.js';
import { createOutboxWriter } from '../../platform/events/outbox-writer.js';
import { systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import { createCreateInvitation } from './create-invitation.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const CREATED_AT = new Date('2026-10-01T00:00:00.000Z');

function testConfig(databaseUrl: string): AppConfig {
  return {
    appEnv: 'test',
    port: 3000,
    databaseUrl,
    authBaseUrl: 'http://localhost:3000',
    authSecret: 'roomies_test_secret_32_chars_minimum_value',
    secureAuthCookies: false,
    frontendOrigin: 'http://localhost:5173',
    trustedOrigins: ['http://localhost:5173'],
    trustProxyHops: 0,
  };
}

function actor(input: {
  userId: string;
  membershipId: string;
  homeId: string;
  role: ActiveHomeActor['role'];
}): ActiveHomeActor {
  return { ...input };
}

async function insertUser(pool: Pool, id: string): Promise<void> {
  await pool.query('INSERT INTO users (id, updated_at) VALUES ($1, NOW())', [
    id,
  ]);
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

async function insertIdentity(
  pool: Pool,
  input: { userId: string; email: string; verified?: boolean },
): Promise<void> {
  await pool.query(
    `INSERT INTO auth_identities (id, name, email, email_verified)
     VALUES ($1, $2, $3, $4)`,
    [
      input.userId,
      'Recipient',
      normalizeEmail(input.email),
      input.verified === true,
    ],
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
    tokenFill: number;
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
      Buffer.from(new Uint8Array(32).fill(input.tokenFill)),
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

async function cleanup(
  pool: Pool,
  input: { homeIds: string[]; userIds: string[] },
): Promise<void> {
  await pool.query('DELETE FROM invitations WHERE home_id = ANY($1::uuid[])', [
    input.homeIds,
  ]);
  await pool.query('DELETE FROM memberships WHERE home_id = ANY($1::uuid[])', [
    input.homeIds,
  ]);
  await pool.query('DELETE FROM homes WHERE id = ANY($1::uuid[])', [
    input.homeIds,
  ]);
  await pool.query('DELETE FROM auth_identities WHERE id = ANY($1::uuid[])', [
    input.userIds,
  ]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
    input.userIds,
  ]);
}

function createCommand(
  pool: Pool,
  overrides: Partial<Parameters<typeof createCreateInvitation>[0]> = {},
) {
  return createCreateInvitation({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeStructure,
    invitations: createInvitationRepository(pool),
    findCanonicalIdentityByEmail: (tx, email) =>
      findCanonicalIdentityByEmail(tx, email),
    clock: { now: () => CREATED_AT },
    ids: {
      next() {
        return randomUUID();
      },
    },
    invitationLifetimeMs: INVITATION_LIFETIME_MS,
    secrets: { generate: generateInvitationSecret },
    ...overrides,
  });
}

void describe('createInvitation PostgreSQL', () => {
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
    'persists digest-only invitation rows and the creator composite FK',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const email = `m22c-create-${randomUUID()}@example.com`;

      try {
        await insertUser(database.pool, userA);
        await insertHome(database.pool, { id: homeId, name: 'Create Home' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ADMIN',
        });

        const create = createCommand(database.pool, {
          ids: { next: () => '018f1e2c-7e3a-7000-8000-1234567890ab' },
        });
        const result = await create({
          actor: actor({
            userId: userA,
            membershipId: membershipA,
            homeId,
            role: 'ADMIN',
          }),
          homeId,
          email: `  ${email.toUpperCase()} `,
        });

        assert.equal(result.invitation.email, normalizeEmail(email));
        assert.deepEqual(
          result.invitation.expiresAt,
          new Date(CREATED_AT.getTime() + INVITATION_LIFETIME_MS),
        );

        const rows = await database.pool.query<{
          invited_email: string;
          token_hash: Uint8Array;
          created_by_membership_id: string;
          home_id: string;
          created_at: Date;
          expires_at: Date;
        }>(
          `SELECT invited_email, token_hash, created_by_membership_id, home_id,
                  created_at, expires_at
           FROM invitations WHERE id = $1`,
          [result.invitation.id],
        );
        assert.equal(rows.rows.length, 1);
        const row = rows.rows[0];
        assert.ok(row);
        assert.equal(row.invited_email, normalizeEmail(email));
        assert.equal(row.created_by_membership_id, membershipA);
        assert.equal(row.home_id, homeId);
        assert.deepEqual(
          [...row.token_hash],
          [
            ...hashInvitationSecretBytes(
              decodeInvitationSecret(result.rawSecret),
            ),
          ],
        );
        assert.equal(JSON.stringify(row).includes(result.rawSecret), false);
        assert.deepEqual(row.created_at, CREATED_AT);
        assert.deepEqual(
          row.expires_at,
          new Date(CREATED_AT.getTime() + INVITATION_LIFETIME_MS),
        );

        const fk = await database.pool.query<{ id: string }>(
          `SELECT id FROM memberships
           WHERE home_id = $1 AND id = $2`,
          [homeId, membershipA],
        );
        assert.equal(fk.rows[0]?.id, membershipA);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userA],
        });
        await database.close();
      }
    },
  );

  void it(
    'conceals missing, archived, and ended-actor Homes and forbids Roommate',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const activeHome = randomUUID();
      const archivedHome = randomUUID();
      const missingHome = randomUUID();
      const membershipA = randomUUID();
      const membershipB = randomUUID();
      const endedMembership = randomUUID();
      const archivedMembership = randomUUID();

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: activeHome, name: 'Active' });
        await insertHome(database.pool, {
          id: archivedHome,
          name: 'Archived',
          archived: true,
        });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId: activeHome,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId: activeHome,
          userId: userB,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: endedMembership,
          homeId: activeHome,
          userId: userB,
          role: 'ADMIN',
          ended: true,
        });
        await insertMembership(database.pool, {
          id: archivedMembership,
          homeId: archivedHome,
          userId: userA,
          role: 'ADMIN',
        });

        const create = createCommand(database.pool);
        await assert.rejects(
          () =>
            create({
              actor: actor({
                userId: userB,
                membershipId: membershipB,
                homeId: activeHome,
                role: 'ROOMMATE',
              }),
              homeId: activeHome,
              email: `m22c-room-${randomUUID()}@example.com`,
            }),
          ForbiddenError,
        );
        await assert.rejects(
          () =>
            create({
              actor: actor({
                userId: userA,
                membershipId: membershipA,
                homeId: missingHome,
                role: 'ADMIN',
              }),
              homeId: missingHome,
              email: `m22c-miss-${randomUUID()}@example.com`,
            }),
          ConcealedNotFoundError,
        );
        await assert.rejects(
          () =>
            create({
              actor: actor({
                userId: userA,
                membershipId: archivedMembership,
                homeId: archivedHome,
                role: 'ADMIN',
              }),
              homeId: archivedHome,
              email: `m22c-arch-${randomUUID()}@example.com`,
            }),
          ConcealedNotFoundError,
        );
        await assert.rejects(
          () =>
            create({
              actor: actor({
                userId: userB,
                membershipId: endedMembership,
                homeId: activeHome,
                role: 'ADMIN',
              }),
              homeId: activeHome,
              email: `m22c-ended-${randomUUID()}@example.com`,
            }),
          ConcealedNotFoundError,
        );

        const leftover = await database.pool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM invitations WHERE home_id = $1',
          [activeHome],
        );
        assert.equal(leftover.rows[0]?.count, '0');
      } finally {
        await cleanup(database.pool, {
          homeIds: [activeHome, archivedHome],
          userIds: [userA, userB],
        });
        await database.close();
      }
    },
  );

  void it(
    'blocks pending duplicates and allows expired, accepted, and revoked priors',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const membershipB = randomUUID();
      const email = `m22c-prior-${randomUUID()}@example.com`;

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeId, name: 'Priors' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId,
          userId: userB,
          role: 'ROOMMATE',
        });

        const create = createCommand(database.pool);
        const commandInput = {
          actor: actor({
            userId: userA,
            membershipId: membershipA,
            homeId,
            role: 'ADMIN',
          }),
          homeId,
          email,
        };

        await insertInvitationRow(database.pool, {
          id: randomUUID(),
          homeId,
          email,
          createdByMembershipId: membershipA,
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
          expiresAt: new Date('2026-09-08T00:00:00.000Z'),
          tokenFill: 21,
        });
        const afterExpired = await create(commandInput);
        assert.equal(afterExpired.invitation.email, normalizeEmail(email));

        await database.pool.query(
          'DELETE FROM invitations WHERE home_id = $1',
          [homeId],
        );
        await insertInvitationRow(database.pool, {
          id: randomUUID(),
          homeId,
          email,
          createdByMembershipId: membershipA,
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
          expiresAt: new Date('2026-09-08T00:00:00.000Z'),
          tokenFill: 22,
          acceptedAt: new Date('2026-09-02T00:00:00.000Z'),
          acceptedMembershipId: membershipB,
        });
        const afterAccepted = await create(commandInput);
        assert.ok(afterAccepted.invitation.id);

        await database.pool.query(
          'DELETE FROM invitations WHERE home_id = $1',
          [homeId],
        );
        await insertInvitationRow(database.pool, {
          id: randomUUID(),
          homeId,
          email,
          createdByMembershipId: membershipA,
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
          expiresAt: new Date('2026-09-08T00:00:00.000Z'),
          tokenFill: 23,
          revokedAt: new Date('2026-09-02T00:00:00.000Z'),
        });
        const afterRevoked = await create(commandInput);
        assert.ok(afterRevoked.invitation.id);

        await assert.rejects(
          () => create(commandInput),
          InvitationAlreadyPendingError,
        );
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userA, userB],
        });
        await database.close();
      }
    },
  );

  void it(
    'detects active recipients and allows missing or unverified accounts',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const userC = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const membershipB = randomUUID();
      const memberEmail = `m22c-member-${randomUUID()}@example.com`;
      const unverifiedEmail = `m22c-unverified-${randomUUID()}@example.com`;
      const missingEmail = `m22c-missing-${randomUUID()}@example.com`;

      try {
        await insertUser(database.pool, userA);
        await insertIdentity(database.pool, {
          userId: userB,
          email: memberEmail,
          verified: true,
        });
        await insertIdentity(database.pool, {
          userId: userC,
          email: unverifiedEmail,
          verified: false,
        });
        await insertHome(database.pool, { id: homeId, name: 'Recipients' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId,
          userId: userB,
          role: 'ROOMMATE',
        });

        const create = createCommand(database.pool);
        const adminActor = actor({
          userId: userA,
          membershipId: membershipA,
          homeId,
          role: 'ADMIN',
        });

        await assert.rejects(
          () => create({ actor: adminActor, homeId, email: memberEmail }),
          AlreadyHomeMemberError,
        );
        const unverified = await create({
          actor: adminActor,
          homeId,
          email: unverifiedEmail,
        });
        const missing = await create({
          actor: adminActor,
          homeId,
          email: missingEmail,
        });
        assert.ok(unverified.invitation.id);
        assert.ok(missing.invitation.id);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userA, userB, userC],
        });
        await database.close();
      }
    },
  );

  void it(
    'serializes concurrent same-Home/email creation to one invitation',
    { skip: skipWithoutDatabase, timeout: 20_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const email = `m22c-race-${randomUUID()}@example.com`;

      try {
        await insertUser(database.pool, userA);
        await insertHome(database.pool, { id: homeId, name: 'Race' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ADMIN',
        });

        const create = createCommand(database.pool);
        const commandInput = {
          actor: actor({
            userId: userA,
            membershipId: membershipA,
            homeId,
            role: 'ADMIN',
          }),
          homeId,
          email,
        };
        const results = await Promise.allSettled([
          create(commandInput),
          create(commandInput),
        ]);
        const fulfilled = results.filter(
          (result) => result.status === 'fulfilled',
        );
        const rejected = results.filter(
          (result) => result.status === 'rejected',
        );
        assert.equal(fulfilled.length, 1);
        assert.equal(rejected.length, 1);
        assert.ok(
          rejected[0]?.status === 'rejected' &&
            rejected[0].reason instanceof InvitationAlreadyPendingError,
        );

        const rows = await database.pool.query<{ id: string }>(
          `SELECT id FROM invitations
           WHERE home_id = $1 AND invited_email = $2
             AND accepted_at IS NULL AND revoked_at IS NULL
             AND expires_at > $3`,
          [homeId, normalizeEmail(email), CREATED_AT],
        );
        assert.equal(rows.rows.length, 1);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userA],
        });
        await database.close();
      }
    },
  );

  void it(
    'serializes Admin create against role demotion without stale Admin writes',
    { skip: skipWithoutDatabase, timeout: 20_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const membershipB = randomUUID();
      const email = `m22c-demote-${randomUUID()}@example.com`;

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeId, name: 'Demote' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId,
          userId: userB,
          role: 'ADMIN',
        });

        const create = createCommand(database.pool);
        const change = createChangeMembershipRole({
          runTransaction: (work) =>
            runInReadCommittedTransaction(database.pool, work),
          lockHomeStructure,
          outbox: createOutboxWriter(),
          clock: { now: () => CREATED_AT },
          ids: systemUuidV7,
          roleWriter: createMembershipRoleWriter(),
        });

        const results = await Promise.allSettled([
          create({
            actor: actor({
              userId: userA,
              membershipId: membershipA,
              homeId,
              role: 'ADMIN',
            }),
            homeId,
            email,
          }),
          change({
            actor: actor({
              userId: userB,
              membershipId: membershipB,
              homeId,
              role: 'ADMIN',
            }),
            homeId,
            membershipId: membershipA,
            role: 'ROOMMATE',
          }),
        ]);

        const createResult = results[0];
        const demoteResult = results[1];
        assert.equal(demoteResult?.status, 'fulfilled');
        const invitations = await database.pool.query<{ id: string }>(
          'SELECT id FROM invitations WHERE home_id = $1',
          [homeId],
        );
        const role = await database.pool.query<{ role: string }>(
          'SELECT role FROM memberships WHERE id = $1',
          [membershipA],
        );
        assert.equal(role.rows[0]?.role, 'ROOMMATE');

        if (createResult?.status === 'fulfilled') {
          assert.equal(invitations.rows.length, 1);
        } else {
          assert.ok(createResult?.reason instanceof ForbiddenError);
          assert.equal(invitations.rows.length, 0);
        }
      } finally {
        await database.pool.query(
          'DELETE FROM outbox_events WHERE home_id = $1',
          [homeId],
        );
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userA, userB],
        });
        await database.close();
      }
    },
  );

  void it(
    'conceals an ended OLD tenure and isolates cross-Home invites',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const homeA = randomUUID();
      const homeB = randomUUID();
      const membershipA = randomUUID();
      const membershipOld = randomUUID();
      const membershipNew = randomUUID();
      const membershipHomeB = randomUUID();
      const email = `m22c-tenure-${randomUUID()}@example.com`;

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeA, name: 'Home A' });
        await insertHome(database.pool, { id: homeB, name: 'Home B' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId: homeA,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipOld,
          homeId: homeA,
          userId: userB,
          role: 'ADMIN',
          ended: true,
        });
        await insertMembership(database.pool, {
          id: membershipNew,
          homeId: homeA,
          userId: userB,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipHomeB,
          homeId: homeB,
          userId: userA,
          role: 'ADMIN',
        });

        const create = createCommand(database.pool);
        await assert.rejects(
          () =>
            create({
              actor: actor({
                userId: userB,
                membershipId: membershipOld,
                homeId: homeA,
                role: 'ADMIN',
              }),
              homeId: homeA,
              email,
            }),
          ConcealedNotFoundError,
        );

        const fromNew = await create({
          actor: actor({
            userId: userB,
            membershipId: membershipNew,
            homeId: homeA,
            role: 'ADMIN',
          }),
          homeId: homeA,
          email,
        });
        const otherHome = await create({
          actor: actor({
            userId: userA,
            membershipId: membershipHomeB,
            homeId: homeB,
            role: 'ADMIN',
          }),
          homeId: homeB,
          email,
        });
        assert.notEqual(fromNew.invitation.id, otherHome.invitation.id);

        const counts = await database.pool.query<{
          home_id: string;
          n: string;
        }>(
          `SELECT home_id, count(*)::text AS n
           FROM invitations
           WHERE invited_email = $1
           GROUP BY home_id`,
          [normalizeEmail(email)],
        );
        assert.equal(counts.rows.length, 2);
        assert.deepEqual(
          new Set(counts.rows.map((row) => row.n)),
          new Set(['1']),
        );
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeA, homeB],
          userIds: [userA, userB],
        });
        await database.close();
      }
    },
  );

  void it(
    'rolls back insert failures without returning a usable invite',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const inner = createInvitationRepository(database.pool);
      const secret = generateInvitationSecret();

      try {
        await insertUser(database.pool, userA);
        await insertHome(database.pool, { id: homeId, name: 'Rollback' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ADMIN',
        });

        const create = createCommand(database.pool, {
          invitations: {
            insert() {
              return Promise.reject(new Error('injected insert failure'));
            },
            findEffectivePending: (tx, input) =>
              inner.findEffectivePending(tx, input),
          },
          secrets: { generate: () => secret },
        });

        await assert.rejects(async () => {
          try {
            await create({
              actor: actor({
                userId: userA,
                membershipId: membershipA,
                homeId,
                role: 'ADMIN',
              }),
              homeId,
              email: `m22c-fail-${randomUUID()}@example.com`,
            });
          } catch (error) {
            assert.equal(
              error instanceof Error && error.message.includes(secret.encoded),
              false,
            );
            throw error;
          }
        }, /injected insert failure/);

        const rows = await database.pool.query<{ id: string }>(
          'SELECT id FROM invitations WHERE home_id = $1',
          [homeId],
        );
        assert.equal(rows.rows.length, 0);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userA],
        });
        await database.close();
      }
    },
  );
});
