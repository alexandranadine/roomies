import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { lockActiveHomeStructureForEntry } from '../../domains/homes/index.js';
import { InvitationNotAvailableError } from '../../domains/invitations/errors.js';
import { createEraseInvitationsForTargetEmail } from '../../domains/invitations/erase-invitations-for-target-email.js';
import { createInvitationRepository } from '../../domains/invitations/repository.js';
import {
  generateInvitationSecret,
  hashInvitationSecretBytes,
  invitationTokenHashesEqual,
} from '../../domains/invitations/secret.js';
import {
  findLatestEndedMembershipTenure,
  insertInvitationMembership,
} from '../../domains/memberships/index.js';
import { createCanonicalUserDeletionMarkerPersistence } from '../../domains/users/canonical-user-deletion-marker.js';
import {
  findCurrentCanonicalIdentityByUser,
  normalizeEmail,
} from '../../platform/auth/index.js';
import type { AppConfig } from '../../platform/config/types.js';
import { outboxWriter } from '../../platform/events/outbox-writer.js';
import { systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import {
  runInReadCommittedTransaction,
  type TransactionContext,
} from '../../platform/persistence/transaction.js';
import { systemClock } from '../../platform/time/clock.js';
import { createAcceptInvitation } from './accept-invitation.js';

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

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 8_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 15);
    });
  }
  throw new Error('timed out waiting for lock wait');
}

async function isWaitingForLock(pool: Pool, pid: number): Promise<boolean> {
  const result = await pool.query<{ wait_event_type: string | null }>(
    'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
    [pid],
  );
  return result.rows[0]?.wait_event_type === 'Lock';
}

async function backendPid(tx: TransactionContext): Promise<number> {
  const result = await tx.query<{ pid: number | string }>(
    'SELECT pg_backend_pid() AS pid',
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('backend pid was missing');
  }
  return Number(row.pid);
}

type Seed = {
  adminId: string;
  userId: string;
  homeId: string;
  adminMembershipId: string;
  invitationId: string;
  secret: ReturnType<typeof generateInvitationSecret>;
  email: ReturnType<typeof normalizeEmail>;
};

async function seedPendingAcceptance(pool: Pool): Promise<Seed> {
  const adminId = randomUUID();
  const userId = randomUUID();
  const homeId = randomUUID();
  const adminMembershipId = randomUUID();
  const invitationId = randomUUID();
  const secret = generateInvitationSecret();
  const email = normalizeEmail(`erase-race-${randomUUID()}@example.com`);
  const createdAt = new Date(Date.now() - 60_000);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

  await pool.query('INSERT INTO users (id, updated_at) VALUES ($1, now())', [
    adminId,
  ]);
  await pool.query(
    `INSERT INTO auth_identities (id, name, email, email_verified)
     VALUES ($1, 'Accepting User', $2, true)`,
    [userId, email],
  );
  await pool.query(
    `INSERT INTO homes (id, name, timezone, updated_at)
     VALUES ($1, 'Erase Race Home', 'UTC', now())`,
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

async function cleanup(pool: Pool, seed: Seed): Promise<void> {
  await pool.query('DELETE FROM outbox_events WHERE home_id = $1', [
    seed.homeId,
  ]);
  await pool.query('DELETE FROM invitations WHERE home_id = $1', [seed.homeId]);
  await pool.query(
    'DELETE FROM membership_role_transitions WHERE home_id = $1',
    [seed.homeId],
  );
  await pool.query(
    `UPDATE memberships
     SET ended_by_membership_id = id
     WHERE home_id = $1 AND ended_at IS NOT NULL`,
    [seed.homeId],
  );
  await pool.query(
    `DELETE FROM memberships
     WHERE home_id = $1 AND ended_at IS NULL`,
    [seed.homeId],
  );
  const remainingMemberships = await pool.query<{ id: string }>(
    'SELECT id FROM memberships WHERE home_id = $1',
    [seed.homeId],
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
  await pool.query('DELETE FROM homes WHERE id = $1', [seed.homeId]);
  await pool.query('DELETE FROM auth_identities WHERE id = $1', [seed.userId]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
    [seed.userId, seed.adminId],
  ]);
}

function eraseCommand(
  pool: Pool,
  options: {
    afterLock?: () => Promise<void>;
    capturePid?: (pid: number) => void;
  } = {},
) {
  const invitations = createInvitationRepository(pool);
  return createEraseInvitationsForTargetEmail({
    async lockByInvitedEmailForErase(tx, input) {
      if (options.capturePid) {
        options.capturePid(await backendPid(tx));
      }
      const locked = await invitations.lockByInvitedEmailForErase(tx, input);
      if (options.afterLock) {
        await options.afterLock();
      }
      return locked;
    },
    deleteLockedForTargetEmailErase: (tx, input) =>
      invitations.deleteLockedForTargetEmailErase(tx, input),
  });
}

function acceptCommand(
  pool: Pool,
  options: {
    afterInvitationLock?: () => Promise<void>;
    capturePid?: (pid: number) => void;
  } = {},
) {
  const repository = createInvitationRepository(pool);
  const canonicalUsers = createCanonicalUserDeletionMarkerPersistence();
  return createAcceptInvitation({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    invitations: {
      findById: repository.findById,
      async lockById(tx, input) {
        if (options.capturePid) {
          options.capturePid(await backendPid(tx));
        }
        const locked = await repository.lockById(tx, input);
        if (options.afterInvitationLock) {
          await options.afterInvitationLock();
        }
        return locked;
      },
      acceptLocked: repository.acceptLocked,
    },
    lockCanonicalUser: (tx, userId) => canonicalUsers.lockByUserId(tx, userId),
    lockHomeStructure: lockActiveHomeStructureForEntry,
    findCurrentIdentity: findCurrentCanonicalIdentityByUser,
    findLatestEndedTenure: findLatestEndedMembershipTenure,
    insertMembership: insertInvitationMembership,
    outbox: outboxWriter,
    clock: systemClock,
    ids: systemUuidV7,
    hashesEqual: invitationTokenHashesEqual,
  });
}

void describe('invitation target-email erasure concurrency PostgreSQL', () => {
  void it(
    'lets acceptance commit first, then erasure deletes the invitation and keeps Membership',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const seed = await seedPendingAcceptance(database.pool);
      try {
        const accept = acceptCommand(database.pool);
        const erase = eraseCommand(database.pool);

        const accepted = await accept({
          invitationId: seed.invitationId,
          userId: seed.userId,
          secret: seed.secret.encoded,
        });

        const beforeMembership = await database.pool.query<{
          id: string;
          ended_at: Date | null;
          joined_at: Date;
        }>('SELECT id, ended_at, joined_at FROM memberships WHERE id = $1', [
          accepted.membershipId,
        ]);
        assert.equal(beforeMembership.rows.length, 1);
        assert.equal(beforeMembership.rows[0]?.ended_at, null);

        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await erase(tx, { invitedEmail: seed.email });
        });

        const invitation = await database.pool.query(
          'SELECT id FROM invitations WHERE id = $1',
          [seed.invitationId],
        );
        assert.equal(invitation.rows.length, 0);

        const afterMembership = await database.pool.query<{
          id: string;
          ended_at: Date | null;
          joined_at: Date;
        }>('SELECT id, ended_at, joined_at FROM memberships WHERE id = $1', [
          accepted.membershipId,
        ]);
        assert.equal(afterMembership.rows.length, 1);
        assert.equal(afterMembership.rows[0]?.ended_at, null);
        assert.equal(
          afterMembership.rows[0]?.joined_at.getTime(),
          beforeMembership.rows[0]?.joined_at.getTime(),
        );
      } finally {
        await cleanup(database.pool, seed);
        await database.pool.end();
      }
    },
  );

  void it(
    'lets erasure win first so acceptance cannot create Membership from the deleted row',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const seed = await seedPendingAcceptance(database.pool);
      const eraseLocked = deferred();
      const eraseMayFinish = deferred();
      const acceptPid = deferred<number>();
      try {
        const erase = eraseCommand(database.pool, {
          afterLock: async () => {
            eraseLocked.resolve();
            await eraseMayFinish.promise;
          },
        });
        const accept = acceptCommand(database.pool, {
          capturePid: (pid) => acceptPid.resolve(pid),
        });

        const erasePromise = runInReadCommittedTransaction(
          database.pool,
          async (tx) => {
            await erase(tx, { invitedEmail: seed.email });
          },
        );
        await eraseLocked.promise;

        const acceptPromise = accept({
          invitationId: seed.invitationId,
          userId: seed.userId,
          secret: seed.secret.encoded,
        });
        const waitingAcceptPid = await acceptPid.promise;
        await waitUntil(() =>
          isWaitingForLock(database.pool, waitingAcceptPid),
        );
        eraseMayFinish.resolve();
        await erasePromise;
        await assert.rejects(acceptPromise, InvitationNotAvailableError);

        const invitation = await database.pool.query(
          'SELECT id FROM invitations WHERE id = $1',
          [seed.invitationId],
        );
        assert.equal(invitation.rows.length, 0);

        const memberships = await database.pool.query(
          `SELECT id FROM memberships
           WHERE home_id = $1 AND user_id = $2`,
          [seed.homeId, seed.userId],
        );
        assert.equal(memberships.rows.length, 0);
      } finally {
        await cleanup(database.pool, seed);
        await database.pool.end();
      }
    },
  );
});
