import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createActivityRepository } from '../../domains/activity/repository.js';
import { lockHomeAndExactMemberships } from '../../domains/homes/lock-home-and-exact-memberships.js';
import { findMaintenanceActivitySource } from '../../domains/maintenance/find-maintenance-activity-source.js';
import { findMaintenanceNotificationSource } from '../../domains/maintenance/find-maintenance-notification-source.js';
import { createMaintenanceRepository } from '../../domains/maintenance/repository.js';
import {
  findMembershipEndedActivitySource,
  findMembershipRoleTransitionActivitySource,
  findMembershipStartedActivitySource,
} from '../../domains/memberships/find-membership-activity-source.js';
import { findMembershipRoleTransitionNotificationSource } from '../../domains/memberships/find-membership-notification-source.js';
import { findSupplyActivitySource } from '../../domains/supplies/find-supply-activity-source.js';
import { findSupplyNotificationSource } from '../../domains/supplies/find-supply-notification-source.js';
import { findTaskActivitySource } from '../../domains/tasks/find-task-activity-source.js';
import { findTaskNotificationSource } from '../../domains/tasks/find-task-notification-source.js';
import type { AppConfig } from '../../platform/config/types.js';
import { createUuidV7, systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import {
  createOutboxConsumerFromPool,
  createOutboxHandlerRegistry,
  type OutboxEventHandler,
} from '../../platform/outbox/index.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import {
  runInReadCommittedTransaction,
  type TransactionContext,
} from '../../platform/persistence/transaction.js';
import { createActivityOutboxHandler } from '../activity/outbox-handler.js';
import { createDeleteActivitiesForSourceFromPool } from '../activity/delete-activities-for-source.js';
import { createNotificationOutboxHandler } from '../notifications/outbox-handler.js';
import { createNotificationPersistenceFromPool } from '../notifications/notification-persistence.js';
import { createDeleteNotificationsForSourceFromPool } from '../notifications/delete-notifications-for-source.js';
import { createCreateMaintenanceEntryFromPool } from './create-maintenance-entry.js';
import { createEraseAuthoredMaintenance } from './erase-authored-maintenance.js';

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

async function waitForBarrier(
  barrier: Promise<unknown>,
  work: Promise<unknown>,
  label: string,
): Promise<void> {
  await Promise.race([
    barrier,
    work.then(() => {
      throw new Error(`${label} finished before the lock barrier`);
    }),
  ]);
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

const silentLogger = {
  info() {},
  error() {},
};

type RaceFixture = {
  homeId: string;
  userAuthor: string;
  userAudience: string;
  author: string;
  audience: string;
  entryId: string;
  eventId: string;
};

async function insertUser(pool: Pool, id: string): Promise<void> {
  await pool.query('INSERT INTO users (id, updated_at) VALUES ($1, NOW())', [
    id,
  ]);
}

async function insertHome(pool: Pool, id: string): Promise<void> {
  await pool.query(
    `INSERT INTO homes (id, name, timezone, archived_at, updated_at)
     VALUES ($1, 'Projection race home', 'UTC', NULL, NOW())`,
    [id],
  );
}

async function insertMembership(
  pool: Pool,
  input: { id: string; homeId: string; userId: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO memberships (id, home_id, user_id, role, ended_at, ended_by_membership_id)
     VALUES ($1, $2, $3, 'ROOMMATE', NULL, NULL)`,
    [input.id, input.homeId, input.userId],
  );
}

async function cleanup(
  pool: Pool,
  input: { homeId: string; userIds: string[] },
): Promise<void> {
  await pool.query('DELETE FROM notifications WHERE home_id = $1', [
    input.homeId,
  ]);
  await pool.query('DELETE FROM activity_recipients WHERE home_id = $1', [
    input.homeId,
  ]);
  await pool.query('DELETE FROM activities WHERE home_id = $1', [input.homeId]);
  await pool.query('DELETE FROM maintenance_audiences WHERE home_id = $1', [
    input.homeId,
  ]);
  await pool.query('DELETE FROM maintenance_entries WHERE home_id = $1', [
    input.homeId,
  ]);
  await pool.query('DELETE FROM outbox_events WHERE home_id = $1', [
    input.homeId,
  ]);
  await pool.query('DELETE FROM memberships WHERE home_id = $1', [
    input.homeId,
  ]);
  await pool.query('DELETE FROM homes WHERE id = $1', [input.homeId]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
    input.userIds,
  ]);
}

async function releaseStaleTestBackends(pool: Pool): Promise<void> {
  await pool.query(`
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
      AND state = 'idle in transaction'
  `);
}

async function drainStrayEvents(pool: Pool): Promise<void> {
  await releaseStaleTestBackends(pool);
  const consumer = createOutboxConsumerFromPool(pool, {
    registry: createOutboxHandlerRegistry([
      activityHandler(pool),
      notificationHandler(pool),
    ]),
    logger: silentLogger,
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await consumer.drain({ batchSize: 20 });
    if (!result.moreWorkLikely) {
      return;
    }
  }
  throw new Error('stray outbox events did not drain');
}

async function seedPendingPrivate(pool: Pool): Promise<RaceFixture> {
  const fixture: RaceFixture = {
    homeId: createUuidV7(),
    userAuthor: randomUUID(),
    userAudience: randomUUID(),
    author: createUuidV7(),
    audience: createUuidV7(),
    entryId: '',
    eventId: '',
  };
  await drainStrayEvents(pool);
  await insertUser(pool, fixture.userAuthor);
  await insertUser(pool, fixture.userAudience);
  await insertHome(pool, fixture.homeId);
  await insertMembership(pool, {
    id: fixture.author,
    homeId: fixture.homeId,
    userId: fixture.userAuthor,
  });
  await insertMembership(pool, {
    id: fixture.audience,
    homeId: fixture.homeId,
    userId: fixture.userAudience,
  });
  const created = await createCreateMaintenanceEntryFromPool(pool)({
    actor: {
      userId: fixture.userAuthor,
      membershipId: fixture.author,
      homeId: fixture.homeId,
      role: 'ROOMMATE',
    },
    homeId: fixture.homeId,
    visibility: 'PRIVATE',
    title: 'Race private source',
    audienceMembershipIds: [fixture.author, fixture.audience],
  });
  const pending = await pool.query<{ event_id: string }>(
    `SELECT event_id
     FROM outbox_events
     WHERE home_id = $1
       AND processed_at IS NULL
     ORDER BY created_at ASC`,
    [fixture.homeId],
  );
  const eventId = pending.rows[0]?.event_id;
  if (eventId === undefined) {
    throw new Error('pending Maintenance outbox event was missing');
  }
  return {
    ...fixture,
    entryId: created.id,
    eventId,
  };
}

type SourceLockHooks = {
  afterLock?: () => Promise<void>;
  capturePid?: (pid: number) => void;
};

function wrapActivitySource(
  hooks: SourceLockHooks,
): typeof findMaintenanceActivitySource {
  return async (tx, input) => {
    if (input.lock === 'forUpdate' && hooks.capturePid) {
      hooks.capturePid(await backendPid(tx));
    }
    const source = await findMaintenanceActivitySource(tx, input);
    if (input.lock === 'forUpdate' && hooks.afterLock) {
      await hooks.afterLock();
    }
    return source;
  };
}

function wrapNotificationSource(
  hooks: SourceLockHooks,
): typeof findMaintenanceNotificationSource {
  return async (tx, input) => {
    if (input.lock === 'forUpdate' && hooks.capturePid) {
      hooks.capturePid(await backendPid(tx));
    }
    const source = await findMaintenanceNotificationSource(tx, input);
    if (input.lock === 'forUpdate' && hooks.afterLock) {
      await hooks.afterLock();
    }
    return source;
  };
}

function activityHandler(
  pool: Pool,
  hooks: SourceLockHooks = {},
): OutboxEventHandler {
  return createActivityOutboxHandler({
    findMaintenanceActivitySource: wrapActivitySource(hooks),
    findTaskActivitySource,
    findSupplyActivitySource,
    findMembershipStartedActivitySource,
    findMembershipEndedActivitySource,
    findMembershipRoleTransitionActivitySource,
    lockHomeAndExactMemberships,
    activity: createActivityRepository(pool),
    ids: systemUuidV7,
  });
}

function notificationHandler(
  pool: Pool,
  hooks: SourceLockHooks = {},
): OutboxEventHandler {
  return createNotificationOutboxHandler({
    findMembershipRoleTransitionSource:
      findMembershipRoleTransitionNotificationSource,
    findTaskSource: findTaskNotificationSource,
    findSupplySource: findSupplyNotificationSource,
    findMaintenanceSource: wrapNotificationSource(hooks),
    lockHomeAndExactMemberships,
    notifications: createNotificationPersistenceFromPool(pool),
    ids: systemUuidV7,
  });
}

function drainOnce(pool: Pool, handlers: readonly OutboxEventHandler[]) {
  return createOutboxConsumerFromPool(pool, {
    registry: createOutboxHandlerRegistry(handlers),
    logger: silentLogger,
  }).drain({ batchSize: 1 });
}

function eraseCommand(pool: Pool, hooks: SourceLockHooks = {}) {
  const maintenance = createMaintenanceRepository(pool);
  return createEraseAuthoredMaintenance({
    deleteNotificationsForSource:
      createDeleteNotificationsForSourceFromPool(pool),
    deleteActivitiesForSource: createDeleteActivitiesForSourceFromPool(pool),
    maintenance: {
      async lockAuthoredSourcesForErase(tx, input) {
        if (hooks.capturePid) {
          hooks.capturePid(await backendPid(tx));
        }
        const sources = await maintenance.lockAuthoredSourcesForErase(
          tx,
          input,
        );
        if (hooks.afterLock) {
          await hooks.afterLock();
        }
        return sources;
      },
      deleteAudienceForErasedSource: (tx, source) =>
        maintenance.deleteAudienceForErasedSource(tx, source),
      deleteAuthoredSource: (tx, source) =>
        maintenance.deleteAuthoredSource(tx, source),
    },
  });
}

async function counts(
  pool: Pool,
  homeId: string,
  entryId: string,
): Promise<
  Readonly<{
    source: number;
    audience: number;
    activities: number;
    recipients: number;
    notifications: number;
  }>
> {
  const source = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM maintenance_entries WHERE id = $1',
    [entryId],
  );
  const audience = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM maintenance_audiences
     WHERE maintenance_entry_id = $1`,
    [entryId],
  );
  const activities = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM activities
     WHERE home_id = $1
       AND source_entity_type = 'MAINTENANCE'
       AND source_entity_id = $2`,
    [homeId, entryId],
  );
  const recipients = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM activity_recipients r
     INNER JOIN activities a
       ON a.id = r.activity_id
      AND a.home_id = r.home_id
     WHERE a.home_id = $1
       AND a.source_entity_type = 'MAINTENANCE'
       AND a.source_entity_id = $2`,
    [homeId, entryId],
  );
  const notifications = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM notifications
     WHERE home_id = $1
       AND source_entity_type = 'MAINTENANCE'
       AND source_entity_id = $2`,
    [homeId, entryId],
  );
  return Object.freeze({
    source: Number(source.rows[0]?.count ?? '-1'),
    audience: Number(audience.rows[0]?.count ?? '-1'),
    activities: Number(activities.rows[0]?.count ?? '-1'),
    recipients: Number(recipients.rows[0]?.count ?? '-1'),
    notifications: Number(notifications.rows[0]?.count ?? '-1'),
  });
}

async function processedAt(pool: Pool, eventId: string): Promise<Date | null> {
  const result = await pool.query<{ processed_at: Date | null }>(
    'SELECT processed_at FROM outbox_events WHERE event_id = $1',
    [eventId],
  );
  return result.rows[0]?.processed_at ?? null;
}

async function assertErasedAndProcessed(
  pool: Pool,
  fixture: RaceFixture,
): Promise<void> {
  assert.deepEqual(await counts(pool, fixture.homeId, fixture.entryId), {
    source: 0,
    audience: 0,
    activities: 0,
    recipients: 0,
    notifications: 0,
  });
  assert.ok(await processedAt(pool, fixture.eventId));
}

void describe('Maintenance projection erasure races PostgreSQL', () => {
  void it(
    'Race A: Activity consumer wins, then erasure deletes the projection',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixture = await seedPendingPrivate(database.pool);
      const consumerLocked = deferred();
      const consumerMayFinish = deferred();
      const erasePid = deferred<number>();
      try {
        const consumerPromise = drainOnce(database.pool, [
          activityHandler(database.pool, {
            afterLock: async () => {
              consumerLocked.resolve();
              await consumerMayFinish.promise;
            },
          }),
        ]);
        await waitForBarrier(
          consumerLocked.promise,
          consumerPromise,
          'Activity consumer',
        );

        const erasePromise = runInReadCommittedTransaction(
          database.pool,
          async (tx) => {
            await eraseCommand(database.pool, {
              capturePid: (pid) => erasePid.resolve(pid),
            })(tx, { membershipIds: [fixture.author] });
          },
        );
        await waitForBarrier(erasePid.promise, erasePromise, 'erasure');
        const waitingErasePid = await erasePid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, waitingErasePid));
        consumerMayFinish.resolve();
        const drained = await consumerPromise;
        assert.equal(drained.processedCount, 1);
        await erasePromise;

        await assertErasedAndProcessed(database.pool, fixture);
        await drainOnce(database.pool, [activityHandler(database.pool)]);
        await assertErasedAndProcessed(database.pool, fixture);
      } finally {
        await cleanup(database.pool, {
          homeId: fixture.homeId,
          userIds: [fixture.userAuthor, fixture.userAudience],
        });
        await database.pool.end();
      }
    },
  );

  void it(
    'Race B: Activity erasure wins, consumer locking re-read no-ops',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixture = await seedPendingPrivate(database.pool);
      const eraseLocked = deferred();
      const eraseMayFinish = deferred();
      const consumerPid = deferred<number>();
      try {
        const erasePromise = runInReadCommittedTransaction(
          database.pool,
          async (tx) => {
            await eraseCommand(database.pool, {
              afterLock: async () => {
                eraseLocked.resolve();
                await eraseMayFinish.promise;
              },
            })(tx, { membershipIds: [fixture.author] });
          },
        );
        await waitForBarrier(eraseLocked.promise, erasePromise, 'erasure');

        const consumerPromise = drainOnce(database.pool, [
          activityHandler(database.pool, {
            capturePid: (pid) => consumerPid.resolve(pid),
          }),
        ]);
        await waitForBarrier(
          consumerPid.promise,
          consumerPromise,
          'Activity consumer',
        );
        const waitingConsumerPid = await consumerPid.promise;
        await waitUntil(() =>
          isWaitingForLock(database.pool, waitingConsumerPid),
        );
        eraseMayFinish.resolve();
        await erasePromise;
        const drained = await consumerPromise;
        assert.equal(drained.processedCount, 1);
        await assertErasedAndProcessed(database.pool, fixture);
      } finally {
        await cleanup(database.pool, {
          homeId: fixture.homeId,
          userIds: [fixture.userAuthor, fixture.userAudience],
        });
        await database.pool.end();
      }
    },
  );

  void it(
    'Race C: Notification consumer wins, then erasure deletes the projection',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixture = await seedPendingPrivate(database.pool);
      const consumerLocked = deferred();
      const consumerMayFinish = deferred();
      const erasePid = deferred<number>();
      try {
        const consumerPromise = drainOnce(database.pool, [
          notificationHandler(database.pool, {
            afterLock: async () => {
              consumerLocked.resolve();
              await consumerMayFinish.promise;
            },
          }),
        ]);
        await waitForBarrier(
          consumerLocked.promise,
          consumerPromise,
          'Notification consumer',
        );

        const erasePromise = runInReadCommittedTransaction(
          database.pool,
          async (tx) => {
            await eraseCommand(database.pool, {
              capturePid: (pid) => erasePid.resolve(pid),
            })(tx, { membershipIds: [fixture.author] });
          },
        );
        await waitForBarrier(erasePid.promise, erasePromise, 'erasure');
        const waitingErasePid = await erasePid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, waitingErasePid));
        consumerMayFinish.resolve();
        const drained = await consumerPromise;
        assert.equal(drained.processedCount, 1);
        await erasePromise;

        await assertErasedAndProcessed(database.pool, fixture);
        await drainOnce(database.pool, [notificationHandler(database.pool)]);
        await assertErasedAndProcessed(database.pool, fixture);
      } finally {
        await cleanup(database.pool, {
          homeId: fixture.homeId,
          userIds: [fixture.userAuthor, fixture.userAudience],
        });
        await database.pool.end();
      }
    },
  );

  void it(
    'Race D: Notification erasure wins, consumer locking re-read no-ops',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixture = await seedPendingPrivate(database.pool);
      const eraseLocked = deferred();
      const eraseMayFinish = deferred();
      const consumerPid = deferred<number>();
      try {
        const erasePromise = runInReadCommittedTransaction(
          database.pool,
          async (tx) => {
            await eraseCommand(database.pool, {
              afterLock: async () => {
                eraseLocked.resolve();
                await eraseMayFinish.promise;
              },
            })(tx, { membershipIds: [fixture.author] });
          },
        );
        await waitForBarrier(eraseLocked.promise, erasePromise, 'erasure');

        const consumerPromise = drainOnce(database.pool, [
          notificationHandler(database.pool, {
            capturePid: (pid) => consumerPid.resolve(pid),
          }),
        ]);
        await waitForBarrier(
          consumerPid.promise,
          consumerPromise,
          'Notification consumer',
        );
        const waitingConsumerPid = await consumerPid.promise;
        await waitUntil(() =>
          isWaitingForLock(database.pool, waitingConsumerPid),
        );
        eraseMayFinish.resolve();
        await erasePromise;
        const drained = await consumerPromise;
        assert.equal(drained.processedCount, 1);
        await assertErasedAndProcessed(database.pool, fixture);
      } finally {
        await cleanup(database.pool, {
          homeId: fixture.homeId,
          userIds: [fixture.userAuthor, fixture.userAudience],
        });
        await database.pool.end();
      }
    },
  );

  void it(
    'combined dispatcher: consumer wins, then erasure deletes both projections',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixture = await seedPendingPrivate(database.pool);
      const consumerLocked = deferred();
      const consumerMayFinish = deferred();
      const erasePid = deferred<number>();
      try {
        const consumerPromise = drainOnce(database.pool, [
          activityHandler(database.pool, {
            afterLock: async () => {
              consumerLocked.resolve();
              await consumerMayFinish.promise;
            },
          }),
          notificationHandler(database.pool),
        ]);
        await waitForBarrier(
          consumerLocked.promise,
          consumerPromise,
          'combined consumer',
        );

        const erasePromise = runInReadCommittedTransaction(
          database.pool,
          async (tx) => {
            await eraseCommand(database.pool, {
              capturePid: (pid) => erasePid.resolve(pid),
            })(tx, { membershipIds: [fixture.author] });
          },
        );
        await waitForBarrier(erasePid.promise, erasePromise, 'erasure');
        const waitingErasePid = await erasePid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, waitingErasePid));
        consumerMayFinish.resolve();
        const drained = await consumerPromise;
        assert.equal(drained.processedCount, 1);
        await erasePromise;

        await assertErasedAndProcessed(database.pool, fixture);
        await drainOnce(database.pool, [
          activityHandler(database.pool),
          notificationHandler(database.pool),
        ]);
        await assertErasedAndProcessed(database.pool, fixture);
      } finally {
        await cleanup(database.pool, {
          homeId: fixture.homeId,
          userIds: [fixture.userAuthor, fixture.userAudience],
        });
        await database.pool.end();
      }
    },
  );

  void it(
    'combined dispatcher: erasure wins, both handlers observe missing source',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixture = await seedPendingPrivate(database.pool);
      const eraseLocked = deferred();
      const eraseMayFinish = deferred();
      const consumerPid = deferred<number>();
      try {
        const erasePromise = runInReadCommittedTransaction(
          database.pool,
          async (tx) => {
            await eraseCommand(database.pool, {
              afterLock: async () => {
                eraseLocked.resolve();
                await eraseMayFinish.promise;
              },
            })(tx, { membershipIds: [fixture.author] });
          },
        );
        await waitForBarrier(eraseLocked.promise, erasePromise, 'erasure');

        const consumerPromise = drainOnce(database.pool, [
          activityHandler(database.pool, {
            capturePid: (pid) => consumerPid.resolve(pid),
          }),
          notificationHandler(database.pool),
        ]);
        await waitForBarrier(
          consumerPid.promise,
          consumerPromise,
          'combined consumer',
        );
        const waitingConsumerPid = await consumerPid.promise;
        await waitUntil(() =>
          isWaitingForLock(database.pool, waitingConsumerPid),
        );
        eraseMayFinish.resolve();
        await erasePromise;
        const drained = await consumerPromise;
        assert.equal(drained.processedCount, 1);
        await assertErasedAndProcessed(database.pool, fixture);
      } finally {
        await cleanup(database.pool, {
          homeId: fixture.homeId,
          userIds: [fixture.userAuthor, fixture.userAudience],
        });
        await database.pool.end();
      }
    },
  );
});
