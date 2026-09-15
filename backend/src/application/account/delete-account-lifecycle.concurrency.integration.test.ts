import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { createActivityRepository } from '../../domains/activity/repository.js';
import { lockHomeAndExactMemberships } from '../../domains/homes/lock-home-and-exact-memberships.js';
import { lockActiveHomeStructureForEntry } from '../../domains/homes/lock-home-structure.js';
import { InvitationNotAvailableError } from '../../domains/invitations/errors.js';
import { createInvitationRepository } from '../../domains/invitations/repository.js';
import {
  generateInvitationSecret,
  hashInvitationSecretBytes,
  invitationTokenHashesEqual,
} from '../../domains/invitations/secret.js';
import { findMaintenanceActivitySource } from '../../domains/maintenance/find-maintenance-activity-source.js';
import {
  findLatestEndedMembershipTenure,
  insertInvitationMembership,
} from '../../domains/memberships/index.js';
import { createCanonicalUserDeletionMarkerPersistence } from '../../domains/users/canonical-user-deletion-marker.js';
import { UnauthenticatedError } from '../../platform/auth/errors.js';
import { findCurrentCanonicalIdentityByUser } from '../../platform/auth/index.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import { outboxWriter } from '../../platform/events/outbox-writer.js';
import { systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import {
  createOutboxConsumerFromPool,
  createOutboxHandlerRegistry,
} from '../../platform/outbox/index.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import { systemClock } from '../../platform/time/clock.js';
import { createActivityOutboxHandler } from '../activity/outbox-handler.js';
import { createCreateHome } from '../homes/create-home.js';
import { insertHome } from '../../domains/homes/insert-home.js';
import { insertActiveMembership } from '../../domains/memberships/insert-active-membership.js';
import { createRemoveMembershipFromPool } from '../home-administration/remove-membership.js';
import { createAcceptInvitation } from '../invitations/accept-invitation.js';
import { createCreateMaintenanceEntryFromPool } from '../maintenance/create-maintenance-entry.js';
import {
  findMembershipEndedActivitySource,
  findMembershipRoleTransitionActivitySource,
  findMembershipStartedActivitySource,
} from '../../domains/memberships/find-membership-activity-source.js';
import { findSupplyActivitySource } from '../../domains/supplies/find-supply-activity-source.js';
import { findTaskActivitySource } from '../../domains/tasks/find-task-activity-source.js';
import { createDeleteAccountLifecycleFromPool } from './delete-account-lifecycle.js';
import {
  backendPid,
  cleanupLifecycle,
  deferred,
  insertAuthAccount,
  insertHome as insertTestHome,
  insertMembership,
  insertPlainUser,
  isWaitingForLock,
  provisionCanonicalUser,
  testConfig,
  uniqueLifecycleEmail,
  releaseStaleTestBackends,
  waitUntil,
} from './delete-account-lifecycle.test-helpers.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();

const silentLogger = {
  info() {},
  error() {},
};

async function seedInvitationHome(
  pool: ReturnType<typeof createDatabasePool>['pool'],
  suffix: string,
) {
  const adminId = randomUUID();
  const email = uniqueLifecycleEmail(`m86-invite-${suffix}`);
  const userId = await provisionCanonicalUser(pool, email);
  const homeId = randomUUID();
  const adminMembershipId = randomUUID();
  const invitationId = randomUUID();
  const secret = generateInvitationSecret();
  await insertPlainUser(pool, adminId);
  await insertTestHome(pool, homeId, 'Invite race home');
  await insertMembership(pool, {
    id: adminMembershipId,
    homeId,
    userId: adminId,
    role: 'ADMIN',
  });
  await pool.query(
    `INSERT INTO invitations (
       id, home_id, invited_email, token_hash, created_by_membership_id,
       created_at, expires_at
     ) VALUES ($1, $2, $3, $4, $5, NOW() - INTERVAL '1 minute', NOW() + INTERVAL '1 hour')`,
    [
      invitationId,
      homeId,
      email,
      Buffer.from(hashInvitationSecretBytes(secret.bytes)),
      adminMembershipId,
    ],
  );
  await insertAuthAccount(pool, userId);
  return {
    adminId,
    userId,
    email,
    homeId,
    adminMembershipId,
    invitationId,
    secret,
  };
}

void describe('account deletion lifecycle concurrency PostgreSQL', () => {
  void it(
    'clears leftover idle-in-transaction backends before races',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      try {
        await releaseStaleTestBackends(database.pool);
      } finally {
        await database.close();
      }
    },
  );
  void it(
    'Race A: lifecycle wins the User lock so Home creation refuses after teardown',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const email = uniqueLifecycleEmail('m86-race-a1');
      const userId = await provisionCanonicalUser(database.pool, email);
      await insertAuthAccount(database.pool, userId);
      const persistence = createCanonicalUserDeletionMarkerPersistence();
      const lifecycleLocked = deferred();
      const lifecycleMayFinish = deferred();
      const createPid = deferred<number>();
      const homeIds: string[] = [];
      const create = createCreateHome({
        runTransaction: (work) =>
          runInReadCommittedTransaction(database.pool, work),
        lockCanonicalUser: async (tx, id) => {
          createPid.resolve(await backendPid(tx));
          return persistence.lockByUserId(tx, id);
        },
        insertHome,
        insertMembership: insertActiveMembership,
        outbox: outboxWriter,
        clock: systemClock,
        ids: systemUuidV7,
      });
      try {
        const lifecycle = createDeleteAccountLifecycleFromPool(database.pool, {
          hooks: {
            afterUserLocked: async () => {
              lifecycleLocked.resolve();
              await lifecycleMayFinish.promise;
            },
          },
        })({ userId });
        await lifecycleLocked.promise;
        const created = create({
          userId,
          name: 'Lifecycle first home',
          timezone: 'UTC',
        }).then((result) => {
          homeIds.push(result.home.id);
          return result;
        });
        const pid = await createPid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));
        lifecycleMayFinish.resolve();
        assert.equal((await lifecycle).outcome, 'completed');
        await assert.rejects(created, UnauthenticatedError);
        const homes = await database.pool.query(
          `SELECT id FROM homes WHERE name = $1`,
          ['Lifecycle first home'],
        );
        assert.equal(homes.rowCount, 0);
      } finally {
        lifecycleMayFinish.resolve();
        await cleanupLifecycle(database.pool, {
          homeIds,
          userIds: [userId],
        });
        await database.close();
      }
    },
  );

  void it(
    'Race A: Home creation wins first and lifecycle then archives the new Membership',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const email = uniqueLifecycleEmail('m86-race-a2');
      const userId = await provisionCanonicalUser(database.pool, email);
      await insertAuthAccount(database.pool, userId);
      const persistence = createCanonicalUserDeletionMarkerPersistence();
      const createLocked = deferred();
      const createMayFinish = deferred();
      const lifecyclePid = deferred<number>();
      const homeIds: string[] = [];
      const create = createCreateHome({
        runTransaction: (work) =>
          runInReadCommittedTransaction(database.pool, work),
        lockCanonicalUser: async (tx, id) => {
          const locked = await persistence.lockByUserId(tx, id);
          createLocked.resolve();
          await createMayFinish.promise;
          return locked;
        },
        insertHome,
        insertMembership: insertActiveMembership,
        outbox: outboxWriter,
        clock: systemClock,
        ids: systemUuidV7,
      });
      try {
        const createdPromise = create({
          userId,
          name: 'Creation first home',
          timezone: 'UTC',
        });
        await createLocked.promise;
        const lifecycle = createDeleteAccountLifecycleFromPool(database.pool, {
          lockCanonicalUser: async (tx, id) => {
            lifecyclePid.resolve(await backendPid(tx));
            return persistence.lockByUserId(tx, id);
          },
        })({ userId });
        const pid = await lifecyclePid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));
        createMayFinish.resolve();
        const created = await createdPromise;
        homeIds.push(created.home.id);
        assert.equal((await lifecycle).outcome, 'completed');
        const home = await database.pool.query<{ archived_at: Date | null }>(
          'SELECT archived_at FROM homes WHERE id = $1',
          [created.home.id],
        );
        const membership = await database.pool.query<{
          ended_at: Date | null;
        }>('SELECT ended_at FROM memberships WHERE id = $1', [
          created.membership.id,
        ]);
        assert.ok(home.rows[0]?.archived_at);
        assert.ok(membership.rows[0]?.ended_at);
      } finally {
        createMayFinish.resolve();
        await cleanupLifecycle(database.pool, {
          homeIds,
          userIds: [userId],
        });
        await database.close();
      }
    },
  );

  void it(
    'Race B: lifecycle wins so invitation acceptance cannot create a Membership',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const persistence = createCanonicalUserDeletionMarkerPersistence();
      const seed = await seedInvitationHome(database.pool, 'life-first');
      const lifecycleLocked = deferred();
      const lifecycleMayFinish = deferred();
      const acceptPid = deferred<number>();
      const accept = createAcceptInvitation({
        runTransaction: (work) =>
          runInReadCommittedTransaction(database.pool, work),
        invitations: createInvitationRepository(database.pool),
        lockCanonicalUser: async (tx, id) => {
          acceptPid.resolve(await backendPid(tx));
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
        const lifecycle = createDeleteAccountLifecycleFromPool(database.pool, {
          hooks: {
            afterUserLocked: async () => {
              lifecycleLocked.resolve();
              await lifecycleMayFinish.promise;
            },
          },
        })({ userId: seed.userId });
        await lifecycleLocked.promise;
        const accepted = accept({
          invitationId: seed.invitationId,
          userId: seed.userId,
          secret: seed.secret.encoded,
        });
        const pid = await acceptPid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));
        lifecycleMayFinish.resolve();
        assert.equal((await lifecycle).outcome, 'completed');
        await assert.rejects(accepted, InvitationNotAvailableError);
        const memberships = await database.pool.query(
          'SELECT id FROM memberships WHERE home_id = $1 AND user_id = $2',
          [seed.homeId, seed.userId],
        );
        assert.equal(memberships.rowCount, 0);
      } finally {
        lifecycleMayFinish.resolve();
        await cleanupLifecycle(database.pool, {
          homeIds: [seed.homeId],
          userIds: [seed.userId, seed.adminId],
        });
        await database.close();
      }
    },
  );

  void it(
    'Race B: acceptance wins first and lifecycle then ends the new Membership',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const persistence = createCanonicalUserDeletionMarkerPersistence();
      const seed = await seedInvitationHome(database.pool, 'accept-first');
      const acceptLocked = deferred();
      const acceptMayFinish = deferred();
      const lifecyclePid = deferred<number>();
      const accept = createAcceptInvitation({
        runTransaction: (work) =>
          runInReadCommittedTransaction(database.pool, work),
        invitations: createInvitationRepository(database.pool),
        lockCanonicalUser: async (tx, id) => {
          const locked = await persistence.lockByUserId(tx, id);
          acceptLocked.resolve();
          await acceptMayFinish.promise;
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
        const acceptedPromise = accept({
          invitationId: seed.invitationId,
          userId: seed.userId,
          secret: seed.secret.encoded,
        });
        await acceptLocked.promise;
        const lifecycle = createDeleteAccountLifecycleFromPool(database.pool, {
          lockCanonicalUser: async (tx, id) => {
            lifecyclePid.resolve(await backendPid(tx));
            return persistence.lockByUserId(tx, id);
          },
        })({ userId: seed.userId });
        const pid = await lifecyclePid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));
        acceptMayFinish.resolve();
        const accepted = await acceptedPromise;
        assert.equal((await lifecycle).outcome, 'completed');
        const membership = await database.pool.query<{
          ended_at: Date | null;
        }>('SELECT ended_at FROM memberships WHERE id = $1', [
          accepted.membershipId,
        ]);
        assert.ok(membership.rows[0]?.ended_at);
      } finally {
        acceptMayFinish.resolve();
        await cleanupLifecycle(database.pool, {
          homeIds: [seed.homeId],
          userIds: [seed.userId, seed.adminId],
        });
        await database.close();
      }
    },
  );

  void it(
    'Race C: the second lifecycle waits, then no-ops after deletedAt commits',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const persistence = createCanonicalUserDeletionMarkerPersistence();
      const email = uniqueLifecycleEmail('m86-race-c');
      const userId = await provisionCanonicalUser(database.pool, email);
      const adminUserId = randomUUID();
      const homeId = randomUUID();
      const membershipId = randomUUID();
      const adminMembershipId = randomUUID();
      await insertAuthAccount(database.pool, userId);
      await insertPlainUser(database.pool, adminUserId);
      await insertTestHome(database.pool, homeId, 'Concurrent lifecycle');
      await insertMembership(database.pool, {
        id: membershipId,
        homeId,
        userId,
        role: 'ROOMMATE',
      });
      await insertMembership(database.pool, {
        id: adminMembershipId,
        homeId,
        userId: adminUserId,
        role: 'ADMIN',
      });
      const firstLocked = deferred();
      const firstMayFinish = deferred();
      const secondPid = deferred<number>();
      try {
        const first = createDeleteAccountLifecycleFromPool(database.pool, {
          hooks: {
            afterUserLocked: async () => {
              firstLocked.resolve();
              await firstMayFinish.promise;
            },
          },
        })({ userId });
        await firstLocked.promise;
        const second = createDeleteAccountLifecycleFromPool(database.pool, {
          lockCanonicalUser: async (tx, id) => {
            secondPid.resolve(await backendPid(tx));
            return persistence.lockByUserId(tx, id);
          },
        })({ userId });
        const pid = await secondPid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));
        firstMayFinish.resolve();
        assert.equal((await first).outcome, 'completed');
        assert.equal((await second).outcome, 'already_deleted');
        const events = await database.pool.query<{ event_type: string }>(
          `SELECT event_type FROM outbox_events
           WHERE home_id = $1 AND event_type = 'membership.ended.v1'`,
          [homeId],
        );
        assert.equal(events.rowCount, 1);
      } finally {
        firstMayFinish.resolve();
        await cleanupLifecycle(database.pool, {
          homeIds: [homeId],
          userIds: [userId, adminUserId],
        });
        await database.close();
      }
    },
  );

  void it(
    'Race D: remove waits on lifecycle Home locks and then observes the ended Membership',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const email = uniqueLifecycleEmail('m86-race-d');
      const userId = await provisionCanonicalUser(database.pool, email);
      const adminUserId = randomUUID();
      const homeId = randomUUID();
      const membershipId = randomUUID();
      const adminMembershipId = randomUUID();
      await insertAuthAccount(database.pool, userId);
      await insertPlainUser(database.pool, adminUserId);
      await insertTestHome(database.pool, homeId, 'Structural race');
      await insertMembership(database.pool, {
        id: membershipId,
        homeId,
        userId,
        role: 'ROOMMATE',
      });
      await insertMembership(database.pool, {
        id: adminMembershipId,
        homeId,
        userId: adminUserId,
        role: 'ADMIN',
      });
      const homesLocked = deferred();
      const lifecycleMayFinish = deferred();
      try {
        const lifecycle = createDeleteAccountLifecycleFromPool(database.pool, {
          hooks: {
            afterHomesLocked: async () => {
              homesLocked.resolve();
              await lifecycleMayFinish.promise;
            },
          },
        })({ userId });
        await homesLocked.promise;
        const remove = createRemoveMembershipFromPool(database.pool)({
          homeId,
          membershipId,
          actor: {
            userId: adminUserId,
            membershipId: adminMembershipId,
            homeId,
            role: 'ADMIN',
          },
        });
        await waitUntil(async () => {
          const waiting = await database.pool.query<{ count: string }>(
            `SELECT count(*)::text AS count
             FROM pg_stat_activity
             WHERE datname = current_database()
               AND wait_event_type = 'Lock'
               AND pid <> pg_backend_pid()`,
          );
          return Number(waiting.rows[0]?.count ?? '0') > 0;
        });
        lifecycleMayFinish.resolve();
        assert.equal((await lifecycle).outcome, 'completed');
        await assert.rejects(remove, ConcealedNotFoundError);
        const membership = await database.pool.query<{
          ended_at: Date | null;
        }>('SELECT ended_at FROM memberships WHERE id = $1', [membershipId]);
        assert.ok(membership.rows[0]?.ended_at);
      } finally {
        lifecycleMayFinish.resolve();
        await cleanupLifecycle(database.pool, {
          homeIds: [homeId],
          userIds: [userId, adminUserId],
        });
        await database.close();
      }
    },
  );

  void it(
    'Race E: Maintenance erasure inside lifecycle keeps no-resurrection guarantees',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      await releaseStaleTestBackends(database.pool);
      const email = uniqueLifecycleEmail('m86-race-e');
      const userId = await provisionCanonicalUser(database.pool, email);
      const audienceUserId = randomUUID();
      const homeId = systemUuidV7.next();
      const author = systemUuidV7.next();
      const audience = systemUuidV7.next();
      await insertAuthAccount(database.pool, userId);
      await insertPlainUser(database.pool, audienceUserId);
      await insertTestHome(database.pool, homeId, 'Maintenance race');
      await insertMembership(database.pool, {
        id: author,
        homeId,
        userId,
        role: 'ROOMMATE',
      });
      await insertMembership(database.pool, {
        id: audience,
        homeId,
        userId: audienceUserId,
        role: 'ADMIN',
      });
      const created = await createCreateMaintenanceEntryFromPool(database.pool)(
        {
          actor: {
            userId,
            membershipId: author,
            homeId,
            role: 'ROOMMATE',
          },
          homeId,
          visibility: 'PRIVATE',
          title: 'Lifecycle race source',
          audienceMembershipIds: [author, audience],
        },
      );
      const pending = await database.pool.query<{ event_id: string }>(
        `SELECT event_id FROM outbox_events
         WHERE home_id = $1 AND processed_at IS NULL
         ORDER BY created_at ASC`,
        [homeId],
      );
      const eventId = pending.rows[0]?.event_id;
      if (eventId === undefined) {
        throw new Error('pending Maintenance outbox event was missing');
      }
      try {
        const result = await createDeleteAccountLifecycleFromPool(
          database.pool,
        )({ userId });
        assert.equal(result.outcome, 'completed');
        await createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([
            createActivityOutboxHandler({
              findMaintenanceActivitySource,
              findTaskActivitySource,
              findSupplyActivitySource,
              findMembershipStartedActivitySource,
              findMembershipEndedActivitySource,
              findMembershipRoleTransitionActivitySource,
              lockHomeAndExactMemberships,
              activity: createActivityRepository(database.pool),
              ids: systemUuidV7,
            }),
          ]),
          logger: silentLogger,
        }).drain({ batchSize: 20 });
        const source = await database.pool.query(
          'SELECT id FROM maintenance_entries WHERE id = $1',
          [created.id],
        );
        const activities = await database.pool.query(
          `SELECT id FROM activities
           WHERE home_id = $1 AND source_entity_type = 'MAINTENANCE'
             AND source_entity_id = $2`,
          [homeId, created.id],
        );
        assert.equal(source.rowCount, 0);
        assert.equal(activities.rowCount, 0);
      } finally {
        await cleanupLifecycle(database.pool, {
          homeIds: [homeId],
          userIds: [userId, audienceUserId],
        });
        await database.close();
      }
    },
  );
});
