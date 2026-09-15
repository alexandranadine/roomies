import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createActivityRepository } from '../../domains/activity/repository.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { createMaintenanceRepository } from '../../domains/maintenance/repository.js';
import { createNotificationRepository } from '../../domains/notifications/repository.js';
import type { AppConfig } from '../../platform/config/types.js';
import { outboxWriter } from '../../platform/events/outbox-writer.js';
import { createUuidV7, systemUuidV7 } from '../../platform/ids/uuid-v7.js';
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
import { lockHomeAndExactMemberships } from '../../domains/homes/lock-home-and-exact-memberships.js';
import { createDeleteActivitiesForSourceFromPool } from '../activity/delete-activities-for-source.js';
import { createDeleteNotificationsForSourceFromPool } from '../notifications/delete-notifications-for-source.js';
import { createEraseAuthoredMaintenance } from './erase-authored-maintenance.js';
import { createResolveMaintenanceEntry } from './resolve-maintenance-entry.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const CREATED = new Date('2026-09-14T16:00:00.000Z');

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

function actor(input: {
  userId: string;
  membershipId: string;
  homeId: string;
}): ActiveHomeActor {
  return { ...input, role: 'ROOMMATE' };
}

async function insertUser(pool: Pool, id: string): Promise<void> {
  await pool.query('INSERT INTO users (id, updated_at) VALUES ($1, NOW())', [
    id,
  ]);
}

async function insertHome(pool: Pool, id: string): Promise<void> {
  await pool.query(
    `INSERT INTO homes (id, name, timezone, archived_at, updated_at)
     VALUES ($1, 'Concurrency home', 'UTC', NULL, NOW())`,
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

type Fixture = {
  homeId: string;
  userAuthor: string;
  userResolver: string;
  author: string;
  resolver: string;
  entryId: string;
};

async function seedOpenHousehold(pool: Pool): Promise<Fixture> {
  const fixture: Fixture = {
    homeId: createUuidV7(),
    userAuthor: randomUUID(),
    userResolver: randomUUID(),
    author: createUuidV7(),
    resolver: createUuidV7(),
    entryId: createUuidV7(),
  };
  await insertUser(pool, fixture.userAuthor);
  await insertUser(pool, fixture.userResolver);
  await insertHome(pool, fixture.homeId);
  await insertMembership(pool, {
    id: fixture.author,
    homeId: fixture.homeId,
    userId: fixture.userAuthor,
  });
  await insertMembership(pool, {
    id: fixture.resolver,
    homeId: fixture.homeId,
    userId: fixture.userResolver,
  });
  const maintenance = createMaintenanceRepository(pool);
  const activity = createActivityRepository(pool);
  const notifications = createNotificationRepository(pool);
  await runInReadCommittedTransaction(pool, async (tx) => {
    await maintenance.insertEntryWithAudience(tx, {
      entry: {
        id: fixture.entryId,
        homeId: fixture.homeId,
        createdByMembershipId: fixture.author,
        visibility: 'HOUSEHOLD',
        title: 'Race source',
        details: null,
        status: 'OPEN',
        resolvedByMembershipId: null,
        resolvedAt: null,
        createdAt: CREATED,
        updatedAt: CREATED,
      },
      audienceMembershipIds: [],
    });
    await activity.insertHomeVisibleActivity(tx, {
      id: createUuidV7(),
      homeId: fixture.homeId,
      sourceOutboxEventId: createUuidV7(),
      sourceEntityType: 'MAINTENANCE',
      sourceEntityId: fixture.entryId,
      eventType: 'maintenance.created.v1',
      actorMembershipId: fixture.author,
      occurredAt: CREATED,
      createdAt: CREATED,
    });
    await notifications.insertNotification(tx, {
      id: createUuidV7(),
      homeId: fixture.homeId,
      recipientMembershipId: fixture.resolver,
      sourceOutboxEventId: createUuidV7(),
      kind: 'ASSIGNED_TASK_COMPLETED',
      sourceEntityType: 'TASK',
      sourceEntityId: createUuidV7(),
      actorMembershipId: fixture.author,
      occurredAt: CREATED,
      createdAt: CREATED,
      readAt: null,
    });
  });
  return fixture;
}

function eraseCommand(
  pool: Pool,
  options: {
    afterLock?: () => Promise<void>;
    capturePid?: (pid: number) => void;
  } = {},
) {
  const maintenance = createMaintenanceRepository(pool);
  return createEraseAuthoredMaintenance({
    deleteNotificationsForSource:
      createDeleteNotificationsForSourceFromPool(pool),
    deleteActivitiesForSource: createDeleteActivitiesForSourceFromPool(pool),
    maintenance: {
      async lockAuthoredSourcesForErase(tx, input) {
        if (options.capturePid) {
          options.capturePid(await backendPid(tx));
        }
        const sources = await maintenance.lockAuthoredSourcesForErase(
          tx,
          input,
        );
        if (options.afterLock) {
          await options.afterLock();
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

function resolveCommand(
  pool: Pool,
  options: {
    afterEntryLock?: () => Promise<void>;
    capturePid?: (pid: number) => void;
  } = {},
) {
  const maintenance = createMaintenanceRepository(pool);
  return createResolveMaintenanceEntry({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeAndExactMemberships: async (tx, input) => {
      if (options.capturePid) {
        options.capturePid(await backendPid(tx));
      }
      return lockHomeAndExactMemberships(tx, input);
    },
    maintenance: {
      async lockVisibleForResolve(
        tx,
        homeId,
        maintenanceEntryId,
        actorMembershipId,
      ) {
        const entry = await maintenance.lockVisibleForResolve(
          tx,
          homeId,
          maintenanceEntryId,
          actorMembershipId,
        );
        if (options.afterEntryLock) {
          await options.afterEntryLock();
        }
        return entry;
      },
      resolveOpenEntry: (tx, input) => maintenance.resolveOpenEntry(tx, input),
    },
    outbox: outboxWriter,
    clock: systemClock,
    ids: systemUuidV7,
  });
}

async function sourceExists(pool: Pool, entryId: string): Promise<boolean> {
  const result = await pool.query<{ id: string }>(
    'SELECT id FROM maintenance_entries WHERE id = $1',
    [entryId],
  );
  return result.rows.length === 1;
}

async function derivedGone(
  pool: Pool,
  homeId: string,
  entryId: string,
): Promise<void> {
  const activities = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM activities
     WHERE home_id = $1
       AND source_entity_type = 'MAINTENANCE'
       AND source_entity_id = $2`,
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
  assert.equal(Number(activities.rows[0]?.count ?? '-1'), 0);
  assert.equal(Number(notifications.rows[0]?.count ?? '-1'), 0);
}

void describe('Maintenance erasure concurrency PostgreSQL', () => {
  void it(
    'lets resolve win, then erasure deletes the resolved authored source',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixture = await seedOpenHousehold(database.pool);
      const resolveLocked = deferred();
      const resolveMayFinish = deferred();
      const erasePid = deferred<number>();
      try {
        const resolve = resolveCommand(database.pool, {
          afterEntryLock: async () => {
            resolveLocked.resolve();
            await resolveMayFinish.promise;
          },
        });
        const erase = eraseCommand(database.pool, {
          capturePid: (pid) => erasePid.resolve(pid),
        });

        const resolvePromise = resolve({
          actor: actor({
            userId: fixture.userResolver,
            membershipId: fixture.resolver,
            homeId: fixture.homeId,
          }),
          homeId: fixture.homeId,
          maintenanceEntryId: fixture.entryId,
        });
        await resolveLocked.promise;

        const erasePromise = runInReadCommittedTransaction(
          database.pool,
          async (tx) => {
            await erase(tx, { membershipIds: [fixture.author] });
          },
        );
        const waitingErasePid = await erasePid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, waitingErasePid));
        resolveMayFinish.resolve();
        const resolved = await resolvePromise;
        assert.equal(resolved.status, 'RESOLVED');
        assert.equal(resolved.resolvedByMembershipId, fixture.resolver);
        await erasePromise;

        assert.equal(await sourceExists(database.pool, fixture.entryId), false);
        await derivedGone(database.pool, fixture.homeId, fixture.entryId);
      } finally {
        await cleanup(database.pool, {
          homeId: fixture.homeId,
          userIds: [fixture.userAuthor, fixture.userResolver],
        });
        await database.pool.end();
      }
    },
  );

  void it(
    'lets erasure hold the Maintenance lock so resolve cannot resurrect the source',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixture = await seedOpenHousehold(database.pool);
      const eraseLocked = deferred();
      const eraseMayFinish = deferred();
      const resolvePid = deferred<number>();
      try {
        const erase = eraseCommand(database.pool, {
          afterLock: async () => {
            eraseLocked.resolve();
            await eraseMayFinish.promise;
          },
        });
        const resolve = resolveCommand(database.pool, {
          capturePid: (pid) => resolvePid.resolve(pid),
        });

        const erasePromise = runInReadCommittedTransaction(
          database.pool,
          async (tx) => {
            await erase(tx, { membershipIds: [fixture.author] });
          },
        );
        await eraseLocked.promise;

        const resolvePromise = resolve({
          actor: actor({
            userId: fixture.userResolver,
            membershipId: fixture.resolver,
            homeId: fixture.homeId,
          }),
          homeId: fixture.homeId,
          maintenanceEntryId: fixture.entryId,
        });
        const waitingResolvePid = await resolvePid.promise;
        await waitUntil(() =>
          isWaitingForLock(database.pool, waitingResolvePid),
        );
        eraseMayFinish.resolve();
        await erasePromise;
        await assert.rejects(resolvePromise, ConcealedNotFoundError);

        assert.equal(await sourceExists(database.pool, fixture.entryId), false);
        await derivedGone(database.pool, fixture.homeId, fixture.entryId);
      } finally {
        await cleanup(database.pool, {
          homeId: fixture.homeId,
          userIds: [fixture.userAuthor, fixture.userResolver],
        });
        await database.pool.end();
      }
    },
  );
});
