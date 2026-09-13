import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { Pool } from 'pg';
import { InvitationNotAvailableError } from '../../domains/invitations/errors.js';
import { createInvitationRepository } from '../../domains/invitations/repository.js';
import {
  generateInvitationSecret,
  hashInvitationSecretBytes,
} from '../../domains/invitations/secret.js';
import { lockHomeStructure } from '../../domains/homes/lock-home-structure.js';
import { normalizeEmail } from '../../platform/auth/index.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  ForbiddenError,
} from '../../platform/authz/errors.js';
import {
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import { createAcceptInvitationFromPool } from '../invitations/accept-invitation.js';
import { createArchiveFinalMemberHomeFromPool } from './archive-final-member-home.js';
import { createChangeMembershipRoleFromPool } from './change-membership-role.js';
import { createRemoveMembershipFromPool } from './remove-membership.js';
import {
  createRevokeInvitation,
  createRevokeInvitationFromPool,
} from './revoke-invitation.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const CREATED_AT = new Date('2026-10-01T00:00:00.000Z');
const EXPIRES_AT = new Date('2026-10-08T00:00:00.000Z');
const REVOKED_AT = new Date('2026-10-02T00:00:00.000Z');

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

async function insertInvitationRow(
  pool: Pool,
  input: {
    id: string;
    homeId: string;
    email: string;
    createdByMembershipId: string;
    createdAt?: Date;
    expiresAt?: Date;
    tokenFill?: number;
    tokenHash?: Uint8Array;
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
      Buffer.from(
        input.tokenHash ??
          (input.tokenFill === undefined
            ? randomBytes(32)
            : new Uint8Array(32).fill(input.tokenFill)),
      ),
      input.createdByMembershipId,
      input.createdAt ?? CREATED_AT,
      input.expiresAt ?? EXPIRES_AT,
      input.acceptedAt ?? null,
      input.acceptedMembershipId ?? null,
      input.revokedAt ?? null,
      input.revokedAt === undefined ? null : 'ADMIN_REVOKED',
    ],
  );
}

type InvitationRow = {
  id: string;
  home_id: string;
  invited_email: string;
  token_hash: Uint8Array;
  created_by_membership_id: string;
  created_at: Date;
  expires_at: Date;
  accepted_at: Date | null;
  accepted_membership_id: string | null;
  revoked_at: Date | null;
  revocation_cause: string | null;
};

async function loadInvitation(
  pool: Pool,
  invitationId: string,
): Promise<InvitationRow> {
  const result = await pool.query<InvitationRow>(
    `SELECT id, home_id, invited_email, token_hash, created_by_membership_id,
            created_at, expires_at, accepted_at, accepted_membership_id,
            revoked_at, revocation_cause
     FROM invitations WHERE id = $1`,
    [invitationId],
  );
  const row = result.rows[0];
  assert.ok(row);
  return row;
}

async function cleanup(
  pool: Pool,
  input: { homeIds: string[]; userIds: string[]; invitationIds?: string[] },
): Promise<void> {
  await pool.query(
    'DELETE FROM outbox_events WHERE home_id = ANY($1::uuid[])',
    [input.homeIds],
  );
  if (input.invitationIds !== undefined && input.invitationIds.length > 0) {
    await pool.query('DELETE FROM invitations WHERE id = ANY($1::uuid[])', [
      input.invitationIds,
    ]);
  }
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

function createClockedRevoke(pool: Pool, at: Date = REVOKED_AT) {
  return createRevokeInvitation({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeStructure,
    invitations: createInvitationRepository(pool),
    clock: { now: () => at },
  });
}

async function seedAdminHome(
  pool: Pool,
  suffix: string,
  options: {
    secondAdmin?: boolean;
    roommate?: boolean;
    createdAt?: Date;
    expiresAt?: Date;
  } = {},
) {
  const adminId = randomUUID();
  const otherId = randomUUID();
  const homeId = randomUUID();
  const adminMembershipId = randomUUID();
  const otherMembershipId = randomUUID();
  const invitationId = randomUUID();
  const email = `m22f-revoke-${suffix}@example.com`;
  const createdAt = options.createdAt ?? new Date(Date.now() - 60_000);
  const expiresAt =
    options.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await insertUser(pool, adminId);
  await insertHome(pool, { id: homeId, name: `Revoke ${suffix}` });
  await insertMembership(pool, {
    id: adminMembershipId,
    homeId,
    userId: adminId,
    role: 'ADMIN',
  });
  if (options.secondAdmin === true || options.roommate === true) {
    await insertUser(pool, otherId);
    await insertMembership(pool, {
      id: otherMembershipId,
      homeId,
      userId: otherId,
      role: options.secondAdmin === true ? 'ADMIN' : 'ROOMMATE',
    });
  }
  await insertInvitationRow(pool, {
    id: invitationId,
    homeId,
    email,
    createdByMembershipId: adminMembershipId,
    createdAt,
    expiresAt,
  });

  return {
    adminId,
    otherId,
    homeId,
    adminMembershipId,
    otherMembershipId,
    invitationId,
    email,
    adminActor: actor({
      userId: adminId,
      membershipId: adminMembershipId,
      homeId,
      role: 'ADMIN',
    }),
    otherActor: actor({
      userId: otherId,
      membershipId: otherMembershipId,
      homeId,
      role: options.secondAdmin === true ? 'ADMIN' : 'ROOMMATE',
    }),
  };
}

async function seedAcceptRace(pool: Pool, suffix: string) {
  const adminId = randomUUID();
  const userId = randomUUID();
  const homeId = randomUUID();
  const adminMembershipId = randomUUID();
  const invitationId = randomUUID();
  const secret = generateInvitationSecret();
  const email = `m22f-race-${suffix}@example.com`;
  const createdAt = new Date(Date.now() - 60_000);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

  await pool.query(
    `INSERT INTO auth_identities (id, name, email, email_verified)
     VALUES ($1, 'Accepting User', $2, true)`,
    [userId, email],
  );
  await pool.query('INSERT INTO users (id, updated_at) VALUES ($1, now())', [
    adminId,
  ]);
  await pool.query(
    `INSERT INTO homes (id, name, timezone, updated_at)
     VALUES ($1, 'Accept Revoke Home', 'UTC', now())`,
    [homeId],
  );
  await pool.query(
    `INSERT INTO memberships (id, home_id, user_id, role)
     VALUES ($1, $2, $3, 'ADMIN')`,
    [adminMembershipId, homeId, adminId],
  );
  await pool.query(
    `INSERT INTO invitations (
       id, home_id, invited_email, token_hash, created_by_membership_id,
       created_at, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      invitationId,
      homeId,
      email,
      Buffer.from(hashInvitationSecretBytes(secret.bytes)),
      adminMembershipId,
      createdAt,
      expiresAt,
    ],
  );

  return {
    adminId,
    userId,
    homeId,
    adminMembershipId,
    invitationId,
    secret,
    email,
  };
}

void describe('revokeInvitation PostgreSQL', () => {
  void it(
    'uses only a dedicated safe TEST_DATABASE_URL',
    { skip: skipWithoutDatabase },
    () => {
      assert.ok(resolveSafeDedicatedTestDatabaseUrl());
    },
  );

  void it(
    'persists Admin revocation once with the injected Clock and exact cause',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const pool = new Pool({
        connectionString: resolveSafeDedicatedTestDatabaseUrl(),
        max: 4,
      });
      const seed = await seedAdminHome(pool, randomUUID(), {
        createdAt: CREATED_AT,
        expiresAt: EXPIRES_AT,
      });
      try {
        const before = await loadInvitation(pool, seed.invitationId);
        const revoke = createClockedRevoke(pool);
        await revoke({
          actor: seed.adminActor,
          homeId: seed.homeId,
          invitationId: seed.invitationId,
        });
        const after = await loadInvitation(pool, seed.invitationId);

        assert.deepEqual(after.revoked_at, REVOKED_AT);
        assert.equal(after.revocation_cause, 'ADMIN_REVOKED');
        assert.equal(after.accepted_at, null);
        assert.equal(after.accepted_membership_id, null);
        assert.deepEqual(after.created_at, before.created_at);
        assert.deepEqual(after.expires_at, before.expires_at);
        assert.equal(after.invited_email, before.invited_email);
        assert.equal(
          after.created_by_membership_id,
          before.created_by_membership_id,
        );
        assert.deepEqual([...after.token_hash], [...before.token_hash]);

        await assert.rejects(
          () =>
            pool.query(
              `UPDATE invitations
               SET accepted_at = $1, accepted_membership_id = $2
               WHERE id = $3`,
              [REVOKED_AT, seed.adminMembershipId, seed.invitationId],
            ),
          (error: unknown) =>
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === '23514',
        );

        const events = await pool.query(
          `SELECT event_id FROM outbox_events WHERE home_id = $1`,
          [seed.homeId],
        );
        assert.equal(events.rowCount, 0);
      } finally {
        await cleanup(pool, {
          homeIds: [seed.homeId],
          userIds: [seed.adminId],
        });
        await pool.end();
      }
    },
  );

  void it(
    'lets a different current Admin revoke and preserves creator Membership history',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const pool = new Pool({
        connectionString: resolveSafeDedicatedTestDatabaseUrl(),
        max: 4,
      });
      const creatorId = randomUUID();
      const adminId = randomUUID();
      const homeId = randomUUID();
      const endedCreatorMembership = randomUUID();
      const adminMembershipId = randomUUID();
      const invitationId = randomUUID();
      try {
        await insertUser(pool, creatorId);
        await insertUser(pool, adminId);
        await insertHome(pool, { id: homeId, name: 'Creator History' });
        await insertMembership(pool, {
          id: endedCreatorMembership,
          homeId,
          userId: creatorId,
          role: 'ADMIN',
          ended: true,
        });
        await insertMembership(pool, {
          id: adminMembershipId,
          homeId,
          userId: adminId,
          role: 'ADMIN',
        });
        await insertInvitationRow(pool, {
          id: invitationId,
          homeId,
          email: `m22f-creator-${randomUUID()}@example.com`,
          createdByMembershipId: endedCreatorMembership,
        });

        const revoke = createClockedRevoke(pool);
        await revoke({
          actor: actor({
            userId: adminId,
            membershipId: adminMembershipId,
            homeId,
            role: 'ADMIN',
          }),
          homeId,
          invitationId,
        });

        const row = await loadInvitation(pool, invitationId);
        assert.equal(row.created_by_membership_id, endedCreatorMembership);
        assert.equal(row.revocation_cause, 'ADMIN_REVOKED');
        assert.deepEqual(row.revoked_at, REVOKED_AT);
      } finally {
        await cleanup(pool, {
          homeIds: [homeId],
          userIds: [creatorId, adminId],
        });
        await pool.end();
      }
    },
  );

  void it(
    'forbids Roommate and a creator who is now Roommate',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const pool = new Pool({
        connectionString: resolveSafeDedicatedTestDatabaseUrl(),
        max: 4,
      });
      const seed = await seedAdminHome(pool, randomUUID(), { roommate: true });
      try {
        const revoke = createClockedRevoke(pool);
        await assert.rejects(
          () =>
            revoke({
              actor: seed.otherActor,
              homeId: seed.homeId,
              invitationId: seed.invitationId,
            }),
          ForbiddenError,
        );

        await pool.query(
          `UPDATE memberships SET role = 'ROOMMATE' WHERE id = $1`,
          [seed.adminMembershipId],
        );
        await pool.query(
          `UPDATE memberships SET role = 'ADMIN' WHERE id = $1`,
          [seed.otherMembershipId],
        );
        await assert.rejects(
          () =>
            revoke({
              actor: actor({
                userId: seed.adminId,
                membershipId: seed.adminMembershipId,
                homeId: seed.homeId,
                role: 'ADMIN',
              }),
              homeId: seed.homeId,
              invitationId: seed.invitationId,
            }),
          ForbiddenError,
        );

        const row = await loadInvitation(pool, seed.invitationId);
        assert.equal(row.revoked_at, null);
        assert.equal(row.revocation_cause, null);
      } finally {
        await cleanup(pool, {
          homeIds: [seed.homeId],
          userIds: [seed.adminId, seed.otherId],
        });
        await pool.end();
      }
    },
  );

  void it(
    'conceals archived Homes, ended tenure, and cross-Home invitation IDs',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const pool = new Pool({
        connectionString: resolveSafeDedicatedTestDatabaseUrl(),
        max: 4,
      });
      const userA = randomUUID();
      const userB = randomUUID();
      const homeA = randomUUID();
      const homeB = randomUUID();
      const archivedHome = randomUUID();
      const membershipA = randomUUID();
      const endedMembership = randomUUID();
      const membershipB = randomUUID();
      const archivedMembership = randomUUID();
      const invitationA = randomUUID();
      const invitationB = randomUUID();
      try {
        await insertUser(pool, userA);
        await insertUser(pool, userB);
        await insertHome(pool, { id: homeA, name: 'Home A' });
        await insertHome(pool, { id: homeB, name: 'Home B' });
        await insertHome(pool, {
          id: archivedHome,
          name: 'Archived',
          archived: true,
        });
        await insertMembership(pool, {
          id: membershipA,
          homeId: homeA,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(pool, {
          id: endedMembership,
          homeId: homeA,
          userId: userB,
          role: 'ADMIN',
          ended: true,
        });
        await insertMembership(pool, {
          id: membershipB,
          homeId: homeB,
          userId: userB,
          role: 'ADMIN',
        });
        await insertMembership(pool, {
          id: archivedMembership,
          homeId: archivedHome,
          userId: userA,
          role: 'ADMIN',
        });
        await insertInvitationRow(pool, {
          id: invitationA,
          homeId: homeA,
          email: `m22f-a-${randomUUID()}@example.com`,
          createdByMembershipId: membershipA,
        });
        await insertInvitationRow(pool, {
          id: invitationB,
          homeId: homeB,
          email: `m22f-b-${randomUUID()}@example.com`,
          createdByMembershipId: membershipB,
        });

        const revoke = createClockedRevoke(pool);
        await assert.rejects(
          () =>
            revoke({
              actor: actor({
                userId: userA,
                membershipId: archivedMembership,
                homeId: archivedHome,
                role: 'ADMIN',
              }),
              homeId: archivedHome,
              invitationId: invitationA,
            }),
          ConcealedNotFoundError,
        );
        await assert.rejects(
          () =>
            revoke({
              actor: actor({
                userId: userB,
                membershipId: endedMembership,
                homeId: homeA,
                role: 'ADMIN',
              }),
              homeId: homeA,
              invitationId: invitationA,
            }),
          ConcealedNotFoundError,
        );
        await assert.rejects(
          () =>
            revoke({
              actor: actor({
                userId: userA,
                membershipId: membershipA,
                homeId: homeA,
                role: 'ADMIN',
              }),
              homeId: homeA,
              invitationId: invitationB,
            }),
          InvitationNotAvailableError,
        );

        const foreign = await loadInvitation(pool, invitationB);
        assert.equal(foreign.revoked_at, null);
        assert.equal(foreign.home_id, homeB);
        const local = await loadInvitation(pool, invitationA);
        assert.equal(local.revoked_at, null);
      } finally {
        await cleanup(pool, {
          homeIds: [homeA, homeB, archivedHome],
          userIds: [userA, userB],
        });
        await pool.end();
      }
    },
  );

  void it(
    'rejects accepted, already revoked, and expired invitations without mutation',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const pool = new Pool({
        connectionString: resolveSafeDedicatedTestDatabaseUrl(),
        max: 4,
      });
      const seed = await seedAdminHome(pool, randomUUID());
      const acceptedId = randomUUID();
      const revokedId = randomUUID();
      const expiredId = randomUUID();
      const acceptedMembershipId = randomUUID();
      try {
        await insertMembership(pool, {
          id: acceptedMembershipId,
          homeId: seed.homeId,
          userId: seed.adminId,
          role: 'ROOMMATE',
          ended: true,
        });
        await insertInvitationRow(pool, {
          id: acceptedId,
          homeId: seed.homeId,
          email: `m22f-accepted-${randomUUID()}@example.com`,
          createdByMembershipId: seed.adminMembershipId,
          acceptedAt: new Date('2026-10-02T00:00:00.000Z'),
          acceptedMembershipId,
        });
        await insertInvitationRow(pool, {
          id: revokedId,
          homeId: seed.homeId,
          email: `m22f-revoked-${randomUUID()}@example.com`,
          createdByMembershipId: seed.adminMembershipId,
          revokedAt: new Date('2026-10-02T00:00:00.000Z'),
        });
        await insertInvitationRow(pool, {
          id: expiredId,
          homeId: seed.homeId,
          email: `m22f-expired-${randomUUID()}@example.com`,
          createdByMembershipId: seed.adminMembershipId,
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
          expiresAt: new Date('2026-09-08T00:00:00.000Z'),
        });

        const revoke = createClockedRevoke(pool);
        const beforeAccepted = await loadInvitation(pool, acceptedId);
        const beforeRevoked = await loadInvitation(pool, revokedId);
        const beforeExpired = await loadInvitation(pool, expiredId);

        for (const invitationId of [acceptedId, revokedId, expiredId]) {
          await assert.rejects(
            () =>
              revoke({
                actor: seed.adminActor,
                homeId: seed.homeId,
                invitationId,
              }),
            InvitationNotAvailableError,
          );
        }

        const afterAccepted = await loadInvitation(pool, acceptedId);
        const afterRevoked = await loadInvitation(pool, revokedId);
        const afterExpired = await loadInvitation(pool, expiredId);
        assert.deepEqual(afterAccepted.accepted_at, beforeAccepted.accepted_at);
        assert.equal(afterAccepted.revoked_at, null);
        assert.deepEqual(afterRevoked.revoked_at, beforeRevoked.revoked_at);
        assert.equal(afterRevoked.accepted_at, null);
        assert.equal(afterExpired.revoked_at, null);
        assert.equal(afterExpired.revocation_cause, null);
        assert.deepEqual(afterExpired.expires_at, beforeExpired.expires_at);
        assert.deepEqual(afterExpired.created_at, beforeExpired.created_at);
      } finally {
        await cleanup(pool, {
          homeIds: [seed.homeId],
          userIds: [seed.adminId],
        });
        await pool.end();
      }
    },
  );
});

void describe('revokeInvitation PostgreSQL concurrency', () => {
  void it(
    'accept vs revoke reaches exactly one terminal winner across 10 races',
    { skip: skipWithoutDatabase, timeout: 120_000 },
    async () => {
      const pool = new Pool({
        connectionString: resolveSafeDedicatedTestDatabaseUrl(),
        max: 8,
      });
      const outcomes = { accepted: 0, revoked: 0 };
      try {
        for (let i = 0; i < 10; i += 1) {
          const seed = await seedAcceptRace(pool, `${i}-${randomUUID()}`);
          try {
            const accept = createAcceptInvitationFromPool(pool);
            const revoke = createRevokeInvitationFromPool(pool);
            const settled = await Promise.allSettled([
              accept({
                invitationId: seed.invitationId,
                userId: seed.userId,
                secret: seed.secret.encoded,
              }),
              revoke({
                actor: actor({
                  userId: seed.adminId,
                  membershipId: seed.adminMembershipId,
                  homeId: seed.homeId,
                  role: 'ADMIN',
                }),
                homeId: seed.homeId,
                invitationId: seed.invitationId,
              }),
            ]);

            const invitation = await loadInvitation(pool, seed.invitationId);
            const memberships = await pool.query<{ id: string }>(
              `SELECT id FROM memberships
               WHERE home_id = $1 AND user_id = $2 AND ended_at IS NULL`,
              [seed.homeId, seed.userId],
            );
            const events = await pool.query<{
              payload: { invitationId: string };
            }>(
              `SELECT payload FROM outbox_events
               WHERE home_id = $1 AND event_type = 'membership.started.v1'`,
              [seed.homeId],
            );

            const accepted = invitation.accepted_at !== null;
            const revoked = invitation.revoked_at !== null;
            assert.notEqual(accepted, revoked);
            assert.equal(invitation.accepted_membership_id !== null, accepted);
            assert.equal(
              invitation.revocation_cause === 'ADMIN_REVOKED',
              revoked,
            );
            assert.equal(memberships.rowCount, accepted ? 1 : 0);
            assert.equal(events.rowCount, accepted ? 1 : 0);
            if (accepted) {
              assert.equal(settled[0]?.status, 'fulfilled');
              assert.equal(settled[1]?.status, 'rejected');
              assert.ok(
                settled[1]?.status === 'rejected' &&
                  settled[1].reason instanceof InvitationNotAvailableError,
              );
              assert.equal(
                invitation.accepted_membership_id,
                memberships.rows[0]?.id,
              );
              assert.equal(
                events.rows[0]?.payload.invitationId,
                seed.invitationId,
              );
              outcomes.accepted += 1;
            } else {
              assert.equal(settled[1]?.status, 'fulfilled');
              assert.equal(settled[0]?.status, 'rejected');
              assert.ok(
                settled[0]?.status === 'rejected' &&
                  settled[0].reason instanceof InvitationNotAvailableError,
              );
              outcomes.revoked += 1;
            }
          } finally {
            await cleanup(pool, {
              homeIds: [seed.homeId],
              userIds: [seed.userId, seed.adminId],
              invitationIds: [seed.invitationId],
            });
          }
        }
        assert.equal(outcomes.accepted + outcomes.revoked, 10);
      } finally {
        await pool.end();
      }
    },
  );

  void it(
    'serializes two concurrent Admin revokes to one mutation',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const pool = new Pool({
        connectionString: resolveSafeDedicatedTestDatabaseUrl(),
        max: 6,
      });
      const seed = await seedAdminHome(pool, randomUUID(), {
        secondAdmin: true,
      });
      try {
        const revoke = createRevokeInvitationFromPool(pool);
        const settled = await Promise.allSettled([
          revoke({
            actor: seed.adminActor,
            homeId: seed.homeId,
            invitationId: seed.invitationId,
          }),
          revoke({
            actor: seed.otherActor,
            homeId: seed.homeId,
            invitationId: seed.invitationId,
          }),
        ]);
        assert.equal(
          settled.filter((result) => result.status === 'fulfilled').length,
          1,
        );
        assert.equal(
          settled.filter((result) => result.status === 'rejected').length,
          1,
        );
        const rejected = settled.find((result) => result.status === 'rejected');
        assert.ok(
          rejected?.status === 'rejected' &&
            rejected.reason instanceof InvitationNotAvailableError,
        );

        const row = await loadInvitation(pool, seed.invitationId);
        assert.ok(row.revoked_at instanceof Date);
        assert.equal(row.revocation_cause, 'ADMIN_REVOKED');
        assert.equal(row.accepted_at, null);
      } finally {
        await cleanup(pool, {
          homeIds: [seed.homeId],
          userIds: [seed.adminId, seed.otherId],
        });
        await pool.end();
      }
    },
  );

  void it(
    'serializes revoke against final-member Home archive without corrupt state',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const pool = new Pool({
        connectionString: resolveSafeDedicatedTestDatabaseUrl(),
        max: 6,
      });
      const seed = await seedAdminHome(pool, randomUUID());
      try {
        const revoke = createRevokeInvitationFromPool(pool);
        const archive = createArchiveFinalMemberHomeFromPool(pool);
        const settled = await Promise.allSettled([
          revoke({
            actor: seed.adminActor,
            homeId: seed.homeId,
            invitationId: seed.invitationId,
          }),
          archive({
            homeId: seed.homeId,
            actor: seed.adminActor,
          }),
        ]);

        const home = await pool.query<{ archived_at: Date | null }>(
          'SELECT archived_at FROM homes WHERE id = $1',
          [seed.homeId],
        );
        const invitation = await loadInvitation(pool, seed.invitationId);
        assert.ok(home.rows[0]?.archived_at instanceof Date);
        assert.equal(invitation.accepted_at, null);
        assert.equal(
          invitation.accepted_at === null || invitation.revoked_at === null,
          true,
        );
        assert.notEqual(
          invitation.accepted_at !== null && invitation.revoked_at !== null,
          true,
        );

        if (settled[0]?.status === 'fulfilled') {
          assert.equal(invitation.revocation_cause, 'ADMIN_REVOKED');
          assert.ok(invitation.revoked_at instanceof Date);
        } else {
          assert.ok(
            settled[0]?.status === 'rejected' &&
              settled[0].reason instanceof ConcealedNotFoundError,
          );
          assert.equal(invitation.revocation_cause, 'HOME_ARCHIVED');
          assert.ok(invitation.revoked_at instanceof Date);
        }
        assert.equal(settled[1]?.status, 'fulfilled');
      } finally {
        await cleanup(pool, {
          homeIds: [seed.homeId],
          userIds: [seed.adminId],
        });
        await pool.end();
      }
    },
  );

  void it(
    'authorizes revoke from the locked role when demotion races',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const pool = new Pool({
        connectionString: resolveSafeDedicatedTestDatabaseUrl(),
        max: 6,
      });
      const seed = await seedAdminHome(pool, randomUUID(), {
        secondAdmin: true,
      });
      try {
        const revoke = createRevokeInvitationFromPool(pool);
        const change = createChangeMembershipRoleFromPool(pool);
        const settled = await Promise.allSettled([
          revoke({
            actor: seed.adminActor,
            homeId: seed.homeId,
            invitationId: seed.invitationId,
          }),
          change({
            actor: seed.otherActor,
            homeId: seed.homeId,
            membershipId: seed.adminMembershipId,
            role: 'ROOMMATE',
          }),
        ]);

        const role = await pool.query<{ role: string }>(
          'SELECT role FROM memberships WHERE id = $1',
          [seed.adminMembershipId],
        );
        const invitation = await loadInvitation(pool, seed.invitationId);
        assert.equal(role.rows[0]?.role, 'ROOMMATE');
        assert.equal(settled[1]?.status, 'fulfilled');

        if (settled[0]?.status === 'fulfilled') {
          assert.equal(invitation.revocation_cause, 'ADMIN_REVOKED');
        } else {
          assert.ok(
            settled[0]?.status === 'rejected' &&
              settled[0].reason instanceof ForbiddenError,
          );
          assert.equal(invitation.revoked_at, null);
        }
      } finally {
        await cleanup(pool, {
          homeIds: [seed.homeId],
          userIds: [seed.adminId, seed.otherId],
        });
        await pool.end();
      }
    },
  );

  void it(
    'denies revoke when the Admin Membership ends first',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const pool = new Pool({
        connectionString: resolveSafeDedicatedTestDatabaseUrl(),
        max: 6,
      });
      const seed = await seedAdminHome(pool, randomUUID(), {
        secondAdmin: true,
      });
      try {
        const revoke = createRevokeInvitationFromPool(pool);
        const remove = createRemoveMembershipFromPool(pool);
        const settled = await Promise.allSettled([
          revoke({
            actor: seed.adminActor,
            homeId: seed.homeId,
            invitationId: seed.invitationId,
          }),
          remove({
            actor: seed.otherActor,
            homeId: seed.homeId,
            membershipId: seed.adminMembershipId,
          }),
        ]);

        const membership = await pool.query<{ ended_at: Date | null }>(
          'SELECT ended_at FROM memberships WHERE id = $1',
          [seed.adminMembershipId],
        );
        const invitation = await loadInvitation(pool, seed.invitationId);
        assert.ok(membership.rows[0]?.ended_at instanceof Date);
        assert.equal(settled[1]?.status, 'fulfilled');

        if (settled[0]?.status === 'fulfilled') {
          assert.equal(invitation.revocation_cause, 'ADMIN_REVOKED');
        } else {
          assert.ok(
            settled[0]?.status === 'rejected' &&
              settled[0].reason instanceof ConcealedNotFoundError,
          );
          assert.equal(invitation.revoked_at, null);
        }
      } finally {
        await cleanup(pool, {
          homeIds: [seed.homeId],
          userIds: [seed.adminId, seed.otherId],
        });
        await pool.end();
      }
    },
  );
});
