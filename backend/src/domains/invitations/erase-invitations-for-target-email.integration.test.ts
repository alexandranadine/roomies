import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { lockActiveHomeStructureForEntry } from '../homes/index.js';
import { normalizeEmail } from '../../platform/auth/index.js';
import type { AppConfig } from '../../platform/config/types.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import {
  createEraseInvitationsForTargetEmail,
  createEraseInvitationsForTargetEmailFromPool,
} from './erase-invitations-for-target-email.js';
import { createInvitationHomeArchiveCleanupFromPool } from './home-archive-cleanup.js';
import { createInvitationRepository } from './repository.js';
import {
  generateInvitationSecret,
  hashInvitationSecretBytes,
} from './secret.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();

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

type SeededInvitation = Readonly<{
  id: string;
  homeId: string;
  invitedEmail: string;
  createdByMembershipId: string;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedMembershipId: string | null;
  revokedAt: Date | null;
  revocationCause: string | null;
}>;

async function insertUser(pool: Pool, id: string): Promise<void> {
  await pool.query('INSERT INTO users (id, updated_at) VALUES ($1, NOW())', [
    id,
  ]);
}

async function insertHome(pool: Pool, id: string, name: string): Promise<void> {
  await pool.query(
    `INSERT INTO homes (id, name, timezone, archived_at, updated_at)
     VALUES ($1, $2, 'UTC', NULL, NOW())`,
    [id, name],
  );
}

async function insertMembership(
  pool: Pool,
  input: {
    id: string;
    homeId: string;
    userId: string;
    role?: 'ADMIN' | 'ROOMMATE';
    ended?: boolean;
    joinedAt?: Date;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO memberships (
       id, home_id, user_id, role, joined_at, ended_at, ended_by_membership_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.id,
      input.homeId,
      input.userId,
      input.role ?? 'ADMIN',
      input.joinedAt ?? new Date('2026-01-01T00:00:00.000Z'),
      input.ended === true ? new Date('2026-06-01T00:00:00.000Z') : null,
      input.ended === true ? input.id : null,
    ],
  );
}

async function insertInvitation(
  pool: Pool,
  invitation: SeededInvitation,
): Promise<void> {
  const secret = generateInvitationSecret();
  await pool.query(
    `INSERT INTO invitations (
       id, home_id, invited_email, token_hash, created_by_membership_id,
       created_at, expires_at, accepted_at, accepted_membership_id,
       revoked_at, revocation_cause
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
     )`,
    [
      invitation.id,
      invitation.homeId,
      invitation.invitedEmail,
      Buffer.from(hashInvitationSecretBytes(secret.bytes)),
      invitation.createdByMembershipId,
      invitation.createdAt,
      invitation.expiresAt,
      invitation.acceptedAt,
      invitation.acceptedMembershipId,
      invitation.revokedAt,
      invitation.revocationCause,
    ],
  );
}

async function cleanup(
  pool: Pool,
  input: { homeIds: string[]; userIds: string[]; invitationIds?: string[] },
): Promise<void> {
  if (input.invitationIds !== undefined && input.invitationIds.length > 0) {
    await pool.query('DELETE FROM invitations WHERE id = ANY($1::uuid[])', [
      input.invitationIds,
    ]);
  }
  if (input.homeIds.length > 0) {
    await pool.query(
      'DELETE FROM invitations WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query(
      'DELETE FROM outbox_events WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query(
      'DELETE FROM membership_role_transitions WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query(
      `UPDATE memberships
       SET ended_by_membership_id = id
       WHERE home_id = ANY($1::uuid[]) AND ended_at IS NOT NULL`,
      [input.homeIds],
    );
    await pool.query(
      `DELETE FROM memberships
       WHERE home_id = ANY($1::uuid[]) AND ended_at IS NULL`,
      [input.homeIds],
    );
    const remainingMemberships = await pool.query<{ id: string }>(
      'SELECT id FROM memberships WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    for (const row of remainingMemberships.rows) {
      await pool.query(
        `UPDATE memberships
         SET ended_at = NULL, ended_by_membership_id = NULL
         WHERE id = $1`,
        [row.id],
      );
      await pool.query('DELETE FROM memberships WHERE id = $1', [row.id]);
    }
    await pool.query('DELETE FROM homes WHERE id = ANY($1::uuid[])', [
      input.homeIds,
    ]);
  }
  if (input.userIds.length > 0) {
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
      input.userIds,
    ]);
  }
}

async function invitationExists(pool: Pool, id: string): Promise<boolean> {
  const result = await pool.query<{ id: string }>(
    'SELECT id FROM invitations WHERE id = $1',
    [id],
  );
  return result.rows.length === 1;
}

async function membershipSnapshot(
  pool: Pool,
  membershipId: string,
): Promise<{
  id: string;
  home_id: string;
  user_id: string;
  role: string;
  joined_at: Date;
  ended_at: Date | null;
}> {
  const result = await pool.query<{
    id: string;
    home_id: string;
    user_id: string;
    role: string;
    joined_at: Date;
    ended_at: Date | null;
  }>(
    `SELECT id, home_id, user_id, role, joined_at, ended_at
     FROM memberships WHERE id = $1`,
    [membershipId],
  );
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.ok(row !== undefined);
  return row;
}

void describe('invitation target-email erasure PostgreSQL', () => {
  void it(
    'deletes pending, expired, revoked, and accepted target rows across Homes',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const target = normalizeEmail(`erase-target-${randomUUID()}@example.com`);
      const other = normalizeEmail(`erase-other-${randomUUID()}@example.com`);
      const adminUser = randomUUID();
      const memberUser = randomUUID();
      const creatorUser = randomUUID();
      const homeA = randomUUID();
      const homeB = randomUUID();
      const homeC = randomUUID();
      const adminA = randomUUID();
      const adminB = randomUUID();
      const adminC = randomUUID();
      const acceptedMember = randomUUID();
      const endedMember = randomUUID();
      const pendingId = randomUUID();
      const expiredId = randomUUID();
      const revokedId = randomUUID();
      const acceptedId = randomUUID();
      const otherEmailId = randomUUID();
      const creatorElsewhereId = randomUUID();
      const now = Date.now();
      const pendingCreatedAt = new Date(now - 3 * 24 * 60 * 60 * 1000);
      const expiresFuture = new Date(now + 4 * 24 * 60 * 60 * 1000);
      const expiredCreatedAt = new Date(now - 20 * 24 * 60 * 60 * 1000);
      const expiredExpiresAt = new Date(now - 10 * 24 * 60 * 60 * 1000);
      const revokedCreatedAt = new Date(now - 9 * 24 * 60 * 60 * 1000);
      const revokedAt = new Date(now - 24 * 60 * 60 * 1000);
      const acceptedCreatedAt = new Date(now - 5 * 24 * 60 * 60 * 1000);
      const acceptedAt = new Date(now - 2 * 24 * 60 * 60 * 1000);
      const endedJoinedAt = new Date('2025-01-01T00:00:00.000Z');

      try {
        await insertUser(database.pool, adminUser);
        await insertUser(database.pool, memberUser);
        await insertUser(database.pool, creatorUser);
        await insertHome(database.pool, homeA, 'Erase Home A');
        await insertHome(database.pool, homeB, 'Erase Home B');
        await insertHome(database.pool, homeC, 'Erase Home C');
        await insertMembership(database.pool, {
          id: adminA,
          homeId: homeA,
          userId: adminUser,
        });
        await insertMembership(database.pool, {
          id: adminB,
          homeId: homeB,
          userId: adminUser,
        });
        await insertMembership(database.pool, {
          id: adminC,
          homeId: homeC,
          userId: creatorUser,
        });
        await insertMembership(database.pool, {
          id: acceptedMember,
          homeId: homeA,
          userId: memberUser,
          role: 'ROOMMATE',
          joinedAt: acceptedAt,
        });
        await insertMembership(database.pool, {
          id: endedMember,
          homeId: homeB,
          userId: memberUser,
          role: 'ROOMMATE',
          ended: true,
          joinedAt: endedJoinedAt,
        });

        // Separate Homes / non-overlapping validity ranges so the email
        // exclusion constraint stays satisfied while seeding every lifecycle.
        await insertInvitation(database.pool, {
          id: pendingId,
          homeId: homeB,
          invitedEmail: target,
          createdByMembershipId: adminB,
          createdAt: pendingCreatedAt,
          expiresAt: expiresFuture,
          acceptedAt: null,
          acceptedMembershipId: null,
          revokedAt: null,
          revocationCause: null,
        });
        await insertInvitation(database.pool, {
          id: expiredId,
          homeId: homeC,
          invitedEmail: target,
          createdByMembershipId: adminC,
          createdAt: expiredCreatedAt,
          expiresAt: expiredExpiresAt,
          acceptedAt: null,
          acceptedMembershipId: null,
          revokedAt: null,
          revocationCause: null,
        });
        await insertInvitation(database.pool, {
          id: revokedId,
          homeId: homeC,
          invitedEmail: target,
          createdByMembershipId: adminC,
          createdAt: revokedCreatedAt,
          expiresAt: expiresFuture,
          acceptedAt: null,
          acceptedMembershipId: null,
          revokedAt,
          revocationCause: 'ADMIN_REVOKED',
        });
        await insertInvitation(database.pool, {
          id: acceptedId,
          homeId: homeA,
          invitedEmail: target,
          createdByMembershipId: adminA,
          createdAt: acceptedCreatedAt,
          expiresAt: expiresFuture,
          acceptedAt,
          acceptedMembershipId: acceptedMember,
          revokedAt: null,
          revocationCause: null,
        });
        await insertInvitation(database.pool, {
          id: otherEmailId,
          homeId: homeA,
          invitedEmail: other,
          createdByMembershipId: adminA,
          createdAt: pendingCreatedAt,
          expiresAt: expiresFuture,
          acceptedAt: null,
          acceptedMembershipId: null,
          revokedAt: null,
          revocationCause: null,
        });
        await insertInvitation(database.pool, {
          id: creatorElsewhereId,
          homeId: homeC,
          invitedEmail: other,
          createdByMembershipId: adminC,
          createdAt: pendingCreatedAt,
          expiresAt: expiresFuture,
          acceptedAt: null,
          acceptedMembershipId: null,
          revokedAt: null,
          revocationCause: null,
        });

        const beforeAccepted = await membershipSnapshot(
          database.pool,
          acceptedMember,
        );
        const beforeEnded = await membershipSnapshot(
          database.pool,
          endedMember,
        );

        const erase = createEraseInvitationsForTargetEmailFromPool(
          database.pool,
        );
        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await erase(tx, { invitedEmail: target });
        });

        assert.equal(await invitationExists(database.pool, pendingId), false);
        assert.equal(await invitationExists(database.pool, expiredId), false);
        assert.equal(await invitationExists(database.pool, revokedId), false);
        assert.equal(await invitationExists(database.pool, acceptedId), false);
        assert.equal(await invitationExists(database.pool, otherEmailId), true);
        assert.equal(
          await invitationExists(database.pool, creatorElsewhereId),
          true,
        );

        const afterAccepted = await membershipSnapshot(
          database.pool,
          acceptedMember,
        );
        const afterEnded = await membershipSnapshot(database.pool, endedMember);
        assert.deepEqual(afterAccepted, beforeAccepted);
        assert.deepEqual(afterEnded, beforeEnded);
        assert.equal(afterAccepted.ended_at, null);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeA, homeB, homeC],
          userIds: [adminUser, memberUser, creatorUser],
        });
        await database.pool.end();
      }
    },
  );

  void it(
    'uses exact existing email-normalization semantics and is safe with no matches',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const stored = normalizeEmail(`erase-exact-${randomUUID()}@example.com`);
      const adminUser = randomUUID();
      const homeId = randomUUID();
      const adminMembershipId = randomUUID();
      const invitationId = randomUUID();
      const now = Date.now();
      try {
        await insertUser(database.pool, adminUser);
        await insertHome(database.pool, homeId, 'Exact Email Home');
        await insertMembership(database.pool, {
          id: adminMembershipId,
          homeId,
          userId: adminUser,
        });
        await insertInvitation(database.pool, {
          id: invitationId,
          homeId,
          invitedEmail: stored,
          createdByMembershipId: adminMembershipId,
          createdAt: new Date(now - 60_000),
          expiresAt: new Date(now + 60 * 60 * 1000),
          acceptedAt: null,
          acceptedMembershipId: null,
          revokedAt: null,
          revocationCause: null,
        });

        const erase = createEraseInvitationsForTargetEmailFromPool(
          database.pool,
        );

        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await erase(tx, {
            invitedEmail: normalizeEmail(`missing-${randomUUID()}@example.com`),
          });
        });
        assert.equal(await invitationExists(database.pool, invitationId), true);

        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await erase(tx, { invitedEmail: stored });
        });
        assert.equal(
          await invitationExists(database.pool, invitationId),
          false,
        );

        const secret = generateInvitationSecret();
        const recreatedId = randomUUID();
        await runInReadCommittedTransaction(database.pool, async (tx) => {
          const invitations = createInvitationRepository(database.pool);
          await invitations.insert(tx, {
            id: recreatedId,
            homeId,
            invitedEmail: stored,
            tokenHash: hashInvitationSecretBytes(secret.bytes),
            createdByMembershipId: adminMembershipId,
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          });
        });
        assert.equal(await invitationExists(database.pool, recreatedId), true);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [adminUser],
        });
        await database.pool.end();
      }
    },
  );

  void it(
    'rolls back and restores deleted invitations when the caller aborts',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const target = normalizeEmail(
        `erase-rollback-${randomUUID()}@example.com`,
      );
      const adminUser = randomUUID();
      const homeId = randomUUID();
      const adminMembershipId = randomUUID();
      const invitationId = randomUUID();
      const now = Date.now();
      try {
        await insertUser(database.pool, adminUser);
        await insertHome(database.pool, homeId, 'Rollback Home');
        await insertMembership(database.pool, {
          id: adminMembershipId,
          homeId,
          userId: adminUser,
        });
        await insertInvitation(database.pool, {
          id: invitationId,
          homeId,
          invitedEmail: target,
          createdByMembershipId: adminMembershipId,
          createdAt: new Date(now - 60_000),
          expiresAt: new Date(now + 60 * 60 * 1000),
          acceptedAt: null,
          acceptedMembershipId: null,
          revokedAt: null,
          revocationCause: null,
        });

        const invitations = createInvitationRepository(database.pool);
        const erase = createEraseInvitationsForTargetEmail({
          lockByInvitedEmailForErase: (tx, input) =>
            invitations.lockByInvitedEmailForErase(tx, input),
          async deleteLockedForTargetEmailErase(tx, input) {
            await invitations.deleteLockedForTargetEmailErase(tx, input);
            throw new Error('forced caller abort');
          },
        });

        await assert.rejects(
          () =>
            runInReadCommittedTransaction(database.pool, async (tx) => {
              await erase(tx, { invitedEmail: target });
            }),
          /forced caller abort/,
        );
        assert.equal(await invitationExists(database.pool, invitationId), true);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [adminUser],
        });
        await database.pool.end();
      }
    },
  );

  void it(
    'shares a caller transaction with Home archive invitation cleanup',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const target = normalizeEmail(
        `erase-archive-${randomUUID()}@example.com`,
      );
      const neighbor = normalizeEmail(
        `erase-neighbor-${randomUUID()}@example.com`,
      );
      const adminUser = randomUUID();
      const homeId = randomUUID();
      const otherHomeId = randomUUID();
      const adminMembershipId = randomUUID();
      const otherAdminMembershipId = randomUUID();
      const targetPendingId = randomUUID();
      const neighborPendingId = randomUUID();
      const otherHomeTargetId = randomUUID();
      const now = Date.now();
      const createdAt = new Date(now - 60_000);
      const expiresAt = new Date(now + 60 * 60 * 1000);
      const archivedAt = new Date(now);
      try {
        await insertUser(database.pool, adminUser);
        await insertHome(database.pool, homeId, 'Archive Combo Home');
        await insertHome(database.pool, otherHomeId, 'Other Combo Home');
        await insertMembership(database.pool, {
          id: adminMembershipId,
          homeId,
          userId: adminUser,
        });
        await insertMembership(database.pool, {
          id: otherAdminMembershipId,
          homeId: otherHomeId,
          userId: adminUser,
        });
        await insertInvitation(database.pool, {
          id: targetPendingId,
          homeId,
          invitedEmail: target,
          createdByMembershipId: adminMembershipId,
          createdAt,
          expiresAt,
          acceptedAt: null,
          acceptedMembershipId: null,
          revokedAt: null,
          revocationCause: null,
        });
        await insertInvitation(database.pool, {
          id: neighborPendingId,
          homeId,
          invitedEmail: neighbor,
          createdByMembershipId: adminMembershipId,
          createdAt,
          expiresAt,
          acceptedAt: null,
          acceptedMembershipId: null,
          revokedAt: null,
          revocationCause: null,
        });
        await insertInvitation(database.pool, {
          id: otherHomeTargetId,
          homeId: otherHomeId,
          invitedEmail: target,
          createdByMembershipId: otherAdminMembershipId,
          createdAt,
          expiresAt,
          acceptedAt: null,
          acceptedMembershipId: null,
          revokedAt: null,
          revocationCause: null,
        });

        const archive = createInvitationHomeArchiveCleanupFromPool(
          database.pool,
        );
        const erase = createEraseInvitationsForTargetEmailFromPool(
          database.pool,
        );

        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await lockActiveHomeStructureForEntry(tx, { homeId });
          await archive.lockPendingForHomeArchive(tx, {
            homeId,
            archivedAt,
            cause: 'HOME_ARCHIVED',
          });
          const revoked = await archive.revokeLockedPendingForHomeArchive(tx, {
            homeId,
            archivedAt,
            cause: 'HOME_ARCHIVED',
          });
          assert.equal(revoked, 2);
          await erase(tx, { invitedEmail: target });
        });

        assert.equal(
          await invitationExists(database.pool, targetPendingId),
          false,
        );
        assert.equal(
          await invitationExists(database.pool, otherHomeTargetId),
          false,
        );
        const neighborRow = await database.pool.query<{
          revoked_at: Date | null;
          revocation_cause: string | null;
        }>(
          `SELECT revoked_at, revocation_cause FROM invitations WHERE id = $1`,
          [neighborPendingId],
        );
        assert.equal(neighborRow.rows.length, 1);
        assert.ok(neighborRow.rows[0]?.revoked_at instanceof Date);
        assert.equal(neighborRow.rows[0]?.revocation_cause, 'HOME_ARCHIVED');
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId, otherHomeId],
          userIds: [adminUser],
        });
        await database.pool.end();
      }
    },
  );
});
