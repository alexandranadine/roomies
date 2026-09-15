import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { InvitationNotAvailableError } from '../domains/invitations/errors.js';
import { createInvitationRepository } from '../domains/invitations/repository.js';
import {
  generateInvitationSecret,
  hashInvitationSecretBytes,
  invitationTokenHashesEqual,
} from '../domains/invitations/secret.js';
import { createCanonicalUserDeletionMarkerPersistence } from '../domains/users/canonical-user-deletion-marker.js';
import { UnauthenticatedError } from '../platform/auth/errors.js';
import type { AppConfig } from '../platform/config/types.js';
import { insertHome } from '../domains/homes/insert-home.js';
import { insertActiveMembership } from '../domains/memberships/insert-active-membership.js';
import { outboxWriter } from '../platform/events/outbox-writer.js';
import { systemUuidV7 } from '../platform/ids/uuid-v7.js';
import { createDatabasePool } from '../platform/persistence/pool.js';
import {
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../platform/persistence/test-database.js';
import {
  runInReadCommittedTransaction,
  type TransactionContext,
} from '../platform/persistence/transaction.js';
import { systemClock } from '../platform/time/clock.js';
import {
  createCreateHome,
  createCreateHomeFromPool,
} from './homes/create-home.js';
import {
  createAcceptInvitation,
  createAcceptInvitationFromPool,
} from './invitations/accept-invitation.js';
import { lockActiveHomeStructureForEntry } from '../domains/homes/index.js';
import {
  findLatestEndedMembershipTenure,
  insertInvitationMembership,
} from '../domains/memberships/index.js';
import { findCurrentCanonicalIdentityByUser } from '../platform/auth/index.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const DELETED_AT = new Date('2026-09-14T21:00:00.000Z');

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
  throw new Error('timed out waiting for canonical user lock wait');
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

async function insertUser(pool: Pool, userId: string): Promise<void> {
  await pool.query('INSERT INTO users (id, updated_at) VALUES ($1, NOW())', [
    userId,
  ]);
}

async function cleanupHomes(pool: Pool, homeIds: string[]): Promise<void> {
  if (homeIds.length === 0) {
    return;
  }
  await pool.query('DELETE FROM outbox_events WHERE home_id = ANY($1)', [
    homeIds,
  ]);
  await pool.query('DELETE FROM invitations WHERE home_id = ANY($1)', [
    homeIds,
  ]);
  await pool.query(
    'DELETE FROM membership_role_transitions WHERE home_id = ANY($1::uuid[])',
    [homeIds],
  );
  await pool.query(
    `UPDATE memberships
     SET ended_by_membership_id = id
     WHERE home_id = ANY($1::uuid[]) AND ended_at IS NOT NULL`,
    [homeIds],
  );
  await pool.query(
    `DELETE FROM memberships
     WHERE home_id = ANY($1::uuid[]) AND ended_at IS NULL`,
    [homeIds],
  );
  const remainingMemberships = await pool.query<{ id: string }>(
    'SELECT id FROM memberships WHERE home_id = ANY($1::uuid[])',
    [homeIds],
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
  await pool.query('DELETE FROM homes WHERE id = ANY($1)', [homeIds]);
}

async function cleanupUsers(pool: Pool, userIds: string[]): Promise<void> {
  if (userIds.length === 0) {
    return;
  }
  await pool.query('DELETE FROM auth_identities WHERE id = ANY($1::uuid[])', [
    userIds,
  ]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
}

async function seedInvitation(
  pool: Pool,
  suffix: string,
): Promise<{
  adminId: string;
  userId: string;
  homeId: string;
  adminMembershipId: string;
  invitationId: string;
  secret: ReturnType<typeof generateInvitationSecret>;
}> {
  const adminId = randomUUID();
  const userId = randomUUID();
  const homeId = randomUUID();
  const adminMembershipId = randomUUID();
  const invitationId = randomUUID();
  const secret = generateInvitationSecret();
  const email = `lock-race-${suffix}@example.com`;
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
     VALUES ($1, 'Lock Race Home', 'UTC', now())`,
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
  };
}

void describe('canonical User lock vs Membership-creating operations', () => {
  void it(
    'blocks Home creation on the User lock until lifecycle sets deletedAt, then refuses',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userId = randomUUID();
      const persistence = createCanonicalUserDeletionMarkerPersistence();
      const aLocked = deferred();
      const aMayFinish = deferred();
      const bPid = deferred<number>();
      let bFinished = false;
      const homeIds: string[] = [];

      const create = createCreateHome({
        runTransaction: (work) =>
          runInReadCommittedTransaction(database.pool, work),
        lockCanonicalUser: async (tx, id) => {
          bPid.resolve(await backendPid(tx));
          return persistence.lockByUserId(tx, id);
        },
        insertHome,
        insertMembership: insertActiveMembership,
        outbox: outboxWriter,
        clock: systemClock,
        ids: systemUuidV7,
      });

      try {
        await insertUser(database.pool, userId);

        const aRun = runInReadCommittedTransaction(
          database.pool,
          async (tx) => {
            await persistence.lockByUserId(tx, userId);
            aLocked.resolve();
            await aMayFinish.promise;
            return persistence.markDeleted(tx, {
              userId,
              deletedAt: DELETED_AT,
            });
          },
        );

        await aLocked.promise;
        const bRun = create({
          userId,
          name: 'Lifecycle First Home',
          timezone: 'UTC',
        }).then(
          (result) => {
            bFinished = true;
            homeIds.push(result.home.id);
            return result;
          },
          (error: unknown) => {
            bFinished = true;
            throw error;
          },
        );

        const pid = await bPid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));
        assert.equal(bFinished, false);

        aMayFinish.resolve();
        await aRun;
        await assert.rejects(bRun, UnauthenticatedError);

        const homes = await database.pool.query(
          `SELECT id FROM homes WHERE name = $1`,
          ['Lifecycle First Home'],
        );
        const memberships = await database.pool.query(
          `SELECT id FROM memberships WHERE user_id = $1`,
          [userId],
        );
        const marker = await database.pool.query<{ deleted_at: Date | null }>(
          'SELECT deleted_at FROM users WHERE id = $1',
          [userId],
        );
        assert.equal(homes.rowCount, 0);
        assert.equal(memberships.rowCount, 0);
        assert.equal(
          marker.rows[0]?.deleted_at?.getTime(),
          DELETED_AT.getTime(),
        );
      } finally {
        aMayFinish.resolve();
        await cleanupHomes(database.pool, homeIds);
        await cleanupUsers(database.pool, [userId]);
        await database.close();
      }
    },
  );

  void it(
    'lets Home creation win the User lock first so lifecycle observes the new ADMIN Membership',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userId = randomUUID();
      const persistence = createCanonicalUserDeletionMarkerPersistence();
      const bLocked = deferred();
      const bMayFinish = deferred();
      const aPid = deferred<number>();
      let aFinished = false;
      const homeIds: string[] = [];

      const create = createCreateHome({
        runTransaction: (work) =>
          runInReadCommittedTransaction(database.pool, work),
        lockCanonicalUser: async (tx, id) => {
          const locked = await persistence.lockByUserId(tx, id);
          bLocked.resolve();
          await bMayFinish.promise;
          return locked;
        },
        insertHome,
        insertMembership: insertActiveMembership,
        outbox: outboxWriter,
        clock: systemClock,
        ids: systemUuidV7,
      });

      try {
        await insertUser(database.pool, userId);

        const bRun = create({
          userId,
          name: 'Creation First Home',
          timezone: 'UTC',
        });
        await bLocked.promise;

        const aRun = runInReadCommittedTransaction(
          database.pool,
          async (tx) => {
            aPid.resolve(await backendPid(tx));
            await persistence.lockByUserId(tx, userId);
            aFinished = true;
            const memberships = await tx.query<{
              id: string;
              role: string;
              ended_at: Date | null;
            }>(
              `SELECT id, role, ended_at
               FROM memberships
               WHERE user_id = $1 AND ended_at IS NULL`,
              [userId],
            );
            return memberships.rows;
          },
        );

        const pid = await aPid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));
        assert.equal(aFinished, false);

        bMayFinish.resolve();
        const created = await bRun;
        homeIds.push(created.home.id);
        const observed = await aRun;

        assert.equal(created.membership.role, 'ADMIN');
        assert.equal(observed.length, 1);
        assert.equal(observed[0]?.id, created.membership.id);
        assert.equal(observed[0]?.role, 'ADMIN');
        assert.equal(observed[0]?.ended_at, null);
      } finally {
        bMayFinish.resolve();
        await cleanupHomes(database.pool, homeIds);
        await cleanupUsers(database.pool, [userId]);
        await database.close();
      }
    },
  );

  void it(
    'blocks invitation acceptance on the User lock until lifecycle sets deletedAt, then refuses',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const persistence = createCanonicalUserDeletionMarkerPersistence();
      const aLocked = deferred();
      const aMayFinish = deferred();
      const bPid = deferred<number>();
      let bFinished = false;
      const seed = await seedInvitation(database.pool, randomUUID());

      const accept = createAcceptInvitation({
        runTransaction: (work) =>
          runInReadCommittedTransaction(database.pool, work),
        invitations: createInvitationRepository(database.pool),
        lockCanonicalUser: async (tx, id) => {
          bPid.resolve(await backendPid(tx));
          return persistence.lockByUserId(tx, id);
        },
        lockHomeStructure: lockActiveHomeStructureForEntry,
        findCurrentIdentity: findCurrentCanonicalIdentityByUser,
        findLatestEndedTenure: findLatestEndedMembershipTenure,
        insertMembership: insertInvitationMembership,
        outbox: outboxWriter,
        clock: systemClock,
        ids: systemUuidV7,
        hashesEqual: invitationTokenHashesEqual,
      });

      try {
        const aRun = runInReadCommittedTransaction(
          database.pool,
          async (tx) => {
            await persistence.lockByUserId(tx, seed.userId);
            aLocked.resolve();
            await aMayFinish.promise;
            return persistence.markDeleted(tx, {
              userId: seed.userId,
              deletedAt: DELETED_AT,
            });
          },
        );

        await aLocked.promise;
        const bRun = accept({
          invitationId: seed.invitationId,
          userId: seed.userId,
          secret: seed.secret.encoded,
        }).then(
          (result) => {
            bFinished = true;
            return result;
          },
          (error: unknown) => {
            bFinished = true;
            throw error;
          },
        );

        const pid = await bPid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));
        assert.equal(bFinished, false);

        aMayFinish.resolve();
        await aRun;
        await assert.rejects(bRun, InvitationNotAvailableError);

        const invitation = await database.pool.query<{
          accepted_at: Date | null;
          accepted_membership_id: string | null;
        }>(
          `SELECT accepted_at, accepted_membership_id
           FROM invitations WHERE id = $1`,
          [seed.invitationId],
        );
        const memberships = await database.pool.query(
          `SELECT id FROM memberships WHERE home_id = $1 AND user_id = $2`,
          [seed.homeId, seed.userId],
        );
        const marker = await database.pool.query<{ deleted_at: Date | null }>(
          'SELECT deleted_at FROM users WHERE id = $1',
          [seed.userId],
        );
        assert.equal(invitation.rows[0]?.accepted_at, null);
        assert.equal(invitation.rows[0]?.accepted_membership_id, null);
        assert.equal(memberships.rowCount, 0);
        assert.equal(
          marker.rows[0]?.deleted_at?.getTime(),
          DELETED_AT.getTime(),
        );
      } finally {
        aMayFinish.resolve();
        await cleanupHomes(database.pool, [seed.homeId]);
        await cleanupUsers(database.pool, [seed.userId, seed.adminId]);
        await database.close();
      }
    },
  );

  void it(
    'lets invitation acceptance win the User lock first so lifecycle observes the new Membership',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const persistence = createCanonicalUserDeletionMarkerPersistence();
      const bLocked = deferred();
      const bMayFinish = deferred();
      const aPid = deferred<number>();
      let aFinished = false;
      const seed = await seedInvitation(database.pool, randomUUID());

      const accept = createAcceptInvitation({
        runTransaction: (work) =>
          runInReadCommittedTransaction(database.pool, work),
        invitations: createInvitationRepository(database.pool),
        lockCanonicalUser: async (tx, id) => {
          const locked = await persistence.lockByUserId(tx, id);
          bLocked.resolve();
          await bMayFinish.promise;
          return locked;
        },
        lockHomeStructure: lockActiveHomeStructureForEntry,
        findCurrentIdentity: findCurrentCanonicalIdentityByUser,
        findLatestEndedTenure: findLatestEndedMembershipTenure,
        insertMembership: insertInvitationMembership,
        outbox: outboxWriter,
        clock: systemClock,
        ids: systemUuidV7,
        hashesEqual: invitationTokenHashesEqual,
      });

      try {
        const bRun = accept({
          invitationId: seed.invitationId,
          userId: seed.userId,
          secret: seed.secret.encoded,
        });
        await bLocked.promise;

        const aRun = runInReadCommittedTransaction(
          database.pool,
          async (tx) => {
            aPid.resolve(await backendPid(tx));
            await persistence.lockByUserId(tx, seed.userId);
            aFinished = true;
            const memberships = await tx.query<{
              id: string;
              ended_at: Date | null;
            }>(
              `SELECT id, ended_at
               FROM memberships
               WHERE home_id = $1 AND user_id = $2 AND ended_at IS NULL`,
              [seed.homeId, seed.userId],
            );
            const invitation = await tx.query<{
              accepted_membership_id: string | null;
            }>(`SELECT accepted_membership_id FROM invitations WHERE id = $1`, [
              seed.invitationId,
            ]);
            return {
              memberships: memberships.rows,
              acceptedMembershipId: invitation.rows[0]?.accepted_membership_id,
            };
          },
        );

        const pid = await aPid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));
        assert.equal(aFinished, false);

        bMayFinish.resolve();
        const accepted = await bRun;
        const observed = await aRun;

        assert.equal(observed.memberships.length, 1);
        assert.equal(observed.memberships[0]?.id, accepted.membershipId);
        assert.equal(observed.memberships[0]?.ended_at, null);
        assert.equal(observed.acceptedMembershipId, accepted.membershipId);
      } finally {
        bMayFinish.resolve();
        await cleanupHomes(database.pool, [seed.homeId]);
        await cleanupUsers(database.pool, [seed.userId, seed.adminId]);
        await database.close();
      }
    },
  );

  void it(
    'does not serialize Home creation and invitation acceptance for different Users',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const persistence = createCanonicalUserDeletionMarkerPersistence();
      const homeUserReady = deferred();
      const inviteUserReady = deferred();
      const release = deferred();
      const homeIds: string[] = [];
      const homeUserId = randomUUID();
      const seed = await seedInvitation(database.pool, randomUUID());

      const create = createCreateHome({
        runTransaction: (work) =>
          runInReadCommittedTransaction(database.pool, work),
        lockCanonicalUser: async (tx, id) => {
          const locked = await persistence.lockByUserId(tx, id);
          homeUserReady.resolve();
          await release.promise;
          return locked;
        },
        insertHome,
        insertMembership: insertActiveMembership,
        outbox: outboxWriter,
        clock: systemClock,
        ids: systemUuidV7,
      });
      const accept = createAcceptInvitation({
        runTransaction: (work) =>
          runInReadCommittedTransaction(database.pool, work),
        invitations: createInvitationRepository(database.pool),
        lockCanonicalUser: async (tx, id) => {
          const locked = await persistence.lockByUserId(tx, id);
          inviteUserReady.resolve();
          await release.promise;
          return locked;
        },
        lockHomeStructure: lockActiveHomeStructureForEntry,
        findCurrentIdentity: findCurrentCanonicalIdentityByUser,
        findLatestEndedTenure: findLatestEndedMembershipTenure,
        insertMembership: insertInvitationMembership,
        outbox: outboxWriter,
        clock: systemClock,
        ids: systemUuidV7,
        hashesEqual: invitationTokenHashesEqual,
      });

      try {
        await insertUser(database.pool, homeUserId);

        const homeRun = create({
          userId: homeUserId,
          name: 'Independent Home',
          timezone: 'UTC',
        });
        const inviteRun = accept({
          invitationId: seed.invitationId,
          userId: seed.userId,
          secret: seed.secret.encoded,
        });

        await Promise.race([
          Promise.all([homeUserReady.promise, inviteUserReady.promise]),
          new Promise<never>((_, reject) => {
            setTimeout(() => {
              reject(new Error('unrelated Users blocked each other'));
            }, 8_000);
          }),
        ]);

        release.resolve();
        const [created, accepted] = await Promise.all([homeRun, inviteRun]);
        homeIds.push(created.home.id, seed.homeId);
        assert.equal(created.membership.role, 'ADMIN');
        assert.equal(accepted.homeId, seed.homeId);
      } finally {
        release.resolve();
        await cleanupHomes(database.pool, [...homeIds, seed.homeId]);
        await cleanupUsers(database.pool, [
          homeUserId,
          seed.userId,
          seed.adminId,
        ]);
        await database.close();
      }
    },
  );

  void it(
    'does not serialize Home creation for two different Users',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const persistence = createCanonicalUserDeletionMarkerPersistence();
      const aReady = deferred();
      const bReady = deferred();
      const release = deferred();
      const userA = randomUUID();
      const userB = randomUUID();
      const homeIds: string[] = [];

      function createFor(
        signalReady: () => void,
      ): ReturnType<typeof createCreateHome> {
        return createCreateHome({
          runTransaction: (work) =>
            runInReadCommittedTransaction(database.pool, work),
          lockCanonicalUser: async (tx, id) => {
            const locked = await persistence.lockByUserId(tx, id);
            signalReady();
            await release.promise;
            return locked;
          },
          insertHome,
          insertMembership: insertActiveMembership,
          outbox: outboxWriter,
          clock: systemClock,
          ids: systemUuidV7,
        });
      }

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);

        const aRun = createFor(() => {
          aReady.resolve();
        })({
          userId: userA,
          name: 'User A Home',
          timezone: 'UTC',
        });
        const bRun = createFor(() => {
          bReady.resolve();
        })({
          userId: userB,
          name: 'User B Home',
          timezone: 'UTC',
        });

        await Promise.race([
          Promise.all([aReady.promise, bReady.promise]),
          new Promise<never>((_, reject) => {
            setTimeout(() => {
              reject(new Error('unrelated Users blocked each other'));
            }, 8_000);
          }),
        ]);

        release.resolve();
        const [left, right] = await Promise.all([aRun, bRun]);
        homeIds.push(left.home.id, right.home.id);
        assert.notEqual(left.home.id, right.home.id);
        assert.equal(left.membership.role, 'ADMIN');
        assert.equal(right.membership.role, 'ADMIN');
      } finally {
        release.resolve();
        await cleanupHomes(database.pool, homeIds);
        await cleanupUsers(database.pool, [userA, userB]);
        await database.close();
      }
    },
  );
});

void describe('canonical User lock smoke from pool factories', () => {
  void it(
    'keeps live Users able to create a Home and accept an invitation',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const seed = await seedInvitation(database.pool, randomUUID());
      const homeIds = [seed.homeId];
      try {
        const create = createCreateHomeFromPool(database.pool);
        const created = await create({
          userId: seed.adminId,
          name: 'Live User Second Home',
          timezone: 'UTC',
        });
        homeIds.push(created.home.id);
        assert.equal(created.membership.role, 'ADMIN');

        const accept = createAcceptInvitationFromPool(database.pool);
        const accepted = await accept({
          invitationId: seed.invitationId,
          userId: seed.userId,
          secret: seed.secret.encoded,
        });
        assert.equal(accepted.homeId, seed.homeId);
      } finally {
        await cleanupHomes(database.pool, homeIds);
        await cleanupUsers(database.pool, [seed.userId, seed.adminId]);
        await database.close();
      }
    },
  );
});
