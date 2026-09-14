import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createActivityOutboxHandlerFromPool } from '../activity/outbox-handler.js';
import { createEndMembershipWithinHomeStructureFromPool } from '../home-administration/end-membership-within-home-structure.js';
import { ActivityProjectionIntegrityError } from '../activity/errors.js';
import {
  MAINTENANCE_CREATED_V1,
  MAINTENANCE_RESOLVED_V1,
} from '../../domains/maintenance/events.js';
import { findMaintenanceNotificationSource } from '../../domains/maintenance/find-maintenance-notification-source.js';
import { findMembershipRoleTransitionNotificationSource } from '../../domains/memberships/find-membership-notification-source.js';
import { findSupplyNotificationSource } from '../../domains/supplies/find-supply-notification-source.js';
import { findTaskNotificationSource } from '../../domains/tasks/find-task-notification-source.js';
import { lockHomeAndExactMemberships } from '../../domains/homes/lock-home-and-exact-memberships.js';
import { lockHomeStructure } from '../../domains/homes/lock-home-structure.js';
import { NotificationPersistenceError } from '../../domains/notifications/errors.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import type { AppConfig } from '../../platform/config/types.js';
import { systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import {
  createOutboxConsumerFromPool,
  createOutboxHandlerRegistry,
  type OutboxEventHandler,
  type OutboxRetryPolicy,
} from '../../platform/outbox/index.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import {
  runInReadCommittedTransaction,
  type TransactionContext,
} from '../../platform/persistence/transaction.js';
import {
  createNotificationPersistenceFromPool,
  type NotificationPersistence,
} from './notification-persistence.js';
import {
  createNotificationOutboxHandler,
  createNotificationOutboxHandlerFromPool,
  type NotificationOutboxHandlerDependencies,
} from './outbox-handler.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const CREATED_AT = new Date('2026-09-13T18:00:00.000Z');
const RESOLVED_AT = new Date('2026-09-13T18:05:00.000Z');
const ENDING_AT = new Date('2026-09-13T18:10:00.000Z');
const RUN_AT = new Date('2026-09-13T20:00:00.000Z');
const ZERO_BACKOFF: OutboxRetryPolicy = Object.freeze({
  maxAttempts: 8,
  backoffMs: () => 0,
});
const silentLogger = {
  info() {},
  error() {},
};

type Fixture = Readonly<{
  homeId: string;
  userIds: readonly string[];
  actorUserId: string;
  actorMembershipId: string;
  firstRecipientMembershipId: string;
  secondRecipientMembershipId: string;
  maintenanceEntryId: string;
  createdEventId: string;
  resolvedEventId: string | null;
}>;

type OutboxState = Readonly<{
  attempt_count: number;
  available_at: Date;
  processed_at: Date | null;
  last_error_code: string | null;
  last_failed_at: Date | null;
}>;

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

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
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
  throw new Error('timed out waiting for PostgreSQL lock');
}

async function backendPid(tx: TransactionContext): Promise<number> {
  const result = await tx.query<{ pid: number | string }>(
    'SELECT pg_backend_pid() AS pid',
  );
  const row = result.rows[0];
  assert.ok(row);
  return Number(row.pid);
}

async function isWaitingForLock(pool: Pool, pid: number): Promise<boolean> {
  const result = await pool.query<{ wait_event_type: string | null }>(
    'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
    [pid],
  );
  return result.rows[0]?.wait_event_type === 'Lock';
}

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
  input: Readonly<{
    id: string;
    homeId: string;
    userId: string;
    role: 'ROOMMATE' | 'ADMIN';
    joinedAt?: Date;
    endedAt?: Date | null;
    endedByMembershipId?: string | null;
  }>,
): Promise<void> {
  await pool.query(
    `INSERT INTO memberships (
       id, home_id, user_id, role, joined_at, ended_at, ended_by_membership_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.id,
      input.homeId,
      input.userId,
      input.role,
      input.joinedAt ?? CREATED_AT,
      input.endedAt ?? null,
      input.endedByMembershipId ?? null,
    ],
  );
}

async function insertMaintenance(
  pool: Pool,
  input: Readonly<{
    id: string;
    homeId: string;
    actorMembershipId: string;
    audienceMembershipIds: readonly string[];
    createdAt: Date;
    resolvedAt?: Date | null;
    resolvedByMembershipId?: string | null;
  }>,
): Promise<void> {
  const resolvedAt = input.resolvedAt ?? null;
  const resolvedByMembershipId = input.resolvedByMembershipId ?? null;
  await pool.query(
    `INSERT INTO maintenance_entries (
       id, home_id, created_by_membership_id, visibility, title, details,
       status, resolved_by_membership_id, resolved_at, created_at, updated_at
     ) VALUES (
       $1, $2, $3, 'PRIVATE', $4, NULL, $5, $6, $7, $8, $9
     )`,
    [
      input.id,
      input.homeId,
      input.actorMembershipId,
      'M7.2 private notification sentinel',
      resolvedAt === null ? 'OPEN' : 'RESOLVED',
      resolvedByMembershipId,
      resolvedAt,
      input.createdAt,
      resolvedAt ?? input.createdAt,
    ],
  );
  await pool.query(
    `INSERT INTO maintenance_audiences (
       home_id, maintenance_entry_id, membership_id, created_at
     )
     SELECT $1, $2, membership_id, $3
     FROM unnest($4::uuid[]) AS audience(membership_id)
     ORDER BY membership_id`,
    [input.homeId, input.id, input.createdAt, [...input.audienceMembershipIds]],
  );
}

async function insertMaintenanceEvent(
  pool: Pool,
  input: Readonly<{
    eventId: string;
    eventType: typeof MAINTENANCE_CREATED_V1 | typeof MAINTENANCE_RESOLVED_V1;
    homeId: string;
    maintenanceEntryId: string;
    occurredAt: Date;
  }>,
): Promise<void> {
  await pool.query(
    `INSERT INTO outbox_events (
       event_id, event_type, occurred_at, created_at, available_at, home_id,
       payload
     ) VALUES ($1, $2, $3, $3, $3, $4, $5::jsonb)`,
    [
      input.eventId,
      input.eventType,
      input.occurredAt,
      input.homeId,
      JSON.stringify({ maintenanceEntryId: input.maintenanceEntryId }),
    ],
  );
}

async function createFixture(
  pool: Pool,
  input: Readonly<{ name: string; resolved?: boolean }>,
): Promise<Fixture> {
  const actorUserId = randomUUID();
  const firstRecipientUserId = randomUUID();
  const secondRecipientUserId = randomUUID();
  const homeId = randomUUID();
  const actorMembershipId = randomUUID();
  const firstRecipientMembershipId = randomUUID();
  const secondRecipientMembershipId = randomUUID();
  const maintenanceEntryId = randomUUID();
  const createdEventId = randomUUID();
  const resolvedEventId = input.resolved === true ? randomUUID() : null;

  await insertUser(pool, actorUserId);
  await insertUser(pool, firstRecipientUserId);
  await insertUser(pool, secondRecipientUserId);
  await insertHome(pool, homeId, input.name);
  await insertMembership(pool, {
    id: actorMembershipId,
    homeId,
    userId: actorUserId,
    role: 'ADMIN',
  });
  await insertMembership(pool, {
    id: firstRecipientMembershipId,
    homeId,
    userId: firstRecipientUserId,
    role: 'ROOMMATE',
  });
  await insertMembership(pool, {
    id: secondRecipientMembershipId,
    homeId,
    userId: secondRecipientUserId,
    role: 'ROOMMATE',
  });
  await insertMaintenance(pool, {
    id: maintenanceEntryId,
    homeId,
    actorMembershipId,
    audienceMembershipIds: [
      actorMembershipId,
      firstRecipientMembershipId,
      secondRecipientMembershipId,
    ],
    createdAt: CREATED_AT,
    resolvedAt: input.resolved === true ? RESOLVED_AT : null,
    resolvedByMembershipId:
      input.resolved === true ? secondRecipientMembershipId : null,
  });
  await insertMaintenanceEvent(pool, {
    eventId: createdEventId,
    eventType: MAINTENANCE_CREATED_V1,
    homeId,
    maintenanceEntryId,
    occurredAt: CREATED_AT,
  });
  if (resolvedEventId !== null) {
    await insertMaintenanceEvent(pool, {
      eventId: resolvedEventId,
      eventType: MAINTENANCE_RESOLVED_V1,
      homeId,
      maintenanceEntryId,
      occurredAt: RESOLVED_AT,
    });
  }

  return Object.freeze({
    homeId,
    userIds: Object.freeze([
      actorUserId,
      firstRecipientUserId,
      secondRecipientUserId,
    ]),
    actorUserId,
    actorMembershipId,
    firstRecipientMembershipId,
    secondRecipientMembershipId,
    maintenanceEntryId,
    createdEventId,
    resolvedEventId,
  });
}

async function cleanup(
  pool: Pool,
  input: Readonly<{ homeIds: readonly string[]; userIds: readonly string[] }>,
): Promise<void> {
  if (input.homeIds.length > 0) {
    const homeIds = [...input.homeIds];
    await pool.query(
      'DELETE FROM activity_recipients WHERE home_id = ANY($1::uuid[])',
      [homeIds],
    );
    await pool.query(
      'DELETE FROM notifications WHERE home_id = ANY($1::uuid[])',
      [homeIds],
    );
    await pool.query('DELETE FROM activities WHERE home_id = ANY($1::uuid[])', [
      homeIds,
    ]);
    await pool.query(
      'DELETE FROM maintenance_audiences WHERE home_id = ANY($1::uuid[])',
      [homeIds],
    );
    await pool.query(
      'DELETE FROM maintenance_entries WHERE home_id = ANY($1::uuid[])',
      [homeIds],
    );
    await pool.query(
      'DELETE FROM outbox_events WHERE home_id = ANY($1::uuid[])',
      [homeIds],
    );
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
    const ended = await pool.query<{ id: string }>(
      `SELECT id FROM memberships
       WHERE home_id = ANY($1::uuid[])`,
      [homeIds],
    );
    for (const row of ended.rows) {
      await pool.query(
        `UPDATE memberships
         SET ended_at = NULL, ended_by_membership_id = NULL
         WHERE id = $1`,
        [row.id],
      );
      await pool.query('DELETE FROM memberships WHERE id = $1', [row.id]);
    }
    await pool.query('DELETE FROM homes WHERE id = ANY($1::uuid[])', [homeIds]);
  }
  if (input.userIds.length > 0) {
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
      [...input.userIds],
    ]);
  }
}

function notificationHandler(
  pool: Pool,
  overrides: Partial<
    Pick<
      NotificationOutboxHandlerDependencies,
      'lockHomeAndExactMemberships' | 'notifications'
    >
  > = {},
): OutboxEventHandler {
  return createNotificationOutboxHandler({
    findMembershipRoleTransitionSource:
      findMembershipRoleTransitionNotificationSource,
    findTaskSource: findTaskNotificationSource,
    findSupplySource: findSupplyNotificationSource,
    findMaintenanceSource: findMaintenanceNotificationSource,
    lockHomeAndExactMemberships:
      overrides.lockHomeAndExactMemberships ?? lockHomeAndExactMemberships,
    notifications:
      overrides.notifications ?? createNotificationPersistenceFromPool(pool),
    ids: systemUuidV7,
  });
}

function consumer(
  pool: Pool,
  handlers: readonly OutboxEventHandler[],
): ReturnType<typeof createOutboxConsumerFromPool> {
  return createOutboxConsumerFromPool(pool, {
    registry: createOutboxHandlerRegistry(handlers),
    retryPolicy: ZERO_BACKOFF,
    clock: { now: () => RUN_AT },
    logger: silentLogger,
  });
}

async function outboxState(pool: Pool, eventId: string): Promise<OutboxState> {
  const result = await pool.query<OutboxState>(
    `SELECT attempt_count, available_at, processed_at, last_error_code,
            last_failed_at
     FROM outbox_events
     WHERE event_id = $1`,
    [eventId],
  );
  const row = result.rows[0];
  assert.ok(row);
  return row;
}

async function projectionCounts(
  pool: Pool,
  homeId: string,
): Promise<
  Readonly<{
    activities: number;
    activityRecipients: number;
    notifications: number;
    kinds: readonly string[];
  }>
> {
  const activities = await pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM activities WHERE home_id = $1',
    [homeId],
  );
  const recipients = await pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM activity_recipients WHERE home_id = $1',
    [homeId],
  );
  const notifications = await pool.query<{ kind: string }>(
    `SELECT kind FROM notifications
     WHERE home_id = $1
     ORDER BY kind, recipient_membership_id`,
    [homeId],
  );
  return Object.freeze({
    activities: activities.rows[0]?.count ?? -1,
    activityRecipients: recipients.rows[0]?.count ?? -1,
    notifications: notifications.rows.length,
    kinds: Object.freeze(notifications.rows.map((row) => row.kind)),
  });
}

async function assertFailureRolledBack(
  pool: Pool,
  fixture: Fixture,
): Promise<void> {
  assert.deepEqual(await projectionCounts(pool, fixture.homeId), {
    activities: 0,
    activityRecipients: 0,
    notifications: 0,
    kinds: [],
  });
  const state = await outboxState(pool, fixture.createdEventId);
  assert.equal(state.processed_at, null);
  assert.equal(state.attempt_count, 1);
  assert.equal(state.last_error_code, 'HANDLER_FAILED');
  assert.deepEqual(state.last_failed_at, RUN_AT);
  assert.deepEqual(state.available_at, RUN_AT);
}

async function assertRaceFinal(pool: Pool, fixture: Fixture): Promise<void> {
  const membership = await pool.query<{ ended_at: Date | null }>(
    'SELECT ended_at FROM memberships WHERE id = $1',
    [fixture.firstRecipientMembershipId],
  );
  assert.deepEqual(membership.rows[0]?.ended_at, ENDING_AT);
  const notifications = await pool.query<{
    recipient_membership_id: string;
  }>(
    `SELECT recipient_membership_id
     FROM notifications
     WHERE source_outbox_event_id = $1
     ORDER BY recipient_membership_id`,
    [fixture.createdEventId],
  );
  assert.deepEqual(
    notifications.rows.map((row) => row.recipient_membership_id),
    [fixture.secondRecipientMembershipId],
  );
  assert.ok((await outboxState(pool, fixture.createdEventId)).processed_at);
}

function endMembership(
  pool: Pool,
  fixture: Fixture,
  hooks: Readonly<{
    capturePid?: (pid: number) => void;
    afterLock?: () => Promise<void>;
  }> = {},
): Promise<void> {
  const end = createEndMembershipWithinHomeStructureFromPool(pool);
  return runInReadCommittedTransaction(pool, async (tx) => {
    if (hooks.capturePid !== undefined) {
      hooks.capturePid(await backendPid(tx));
    }
    await lockHomeStructure(tx, {
      homeId: fixture.homeId,
      actor: actor({
        userId: fixture.actorUserId,
        membershipId: fixture.actorMembershipId,
        homeId: fixture.homeId,
        role: 'ADMIN',
      }),
    });
    if (hooks.afterLock !== undefined) {
      await hooks.afterLock();
    }
    await end(tx, {
      homeId: fixture.homeId,
      membershipId: fixture.firstRecipientMembershipId,
      endedAt: ENDING_AT,
      endedByMembershipId: fixture.actorMembershipId,
      cause: 'ADMIN_REMOVAL',
    });
  });
}

void describe('Notification outbox PostgreSQL integration and concurrency', () => {
  void it('reports dedicated PostgreSQL availability consistently', () => {
    assert.equal(
      skipWithoutDatabase === false,
      Boolean(process.env['TEST_DATABASE_URL']?.trim()),
    );
    if (skipWithoutDatabase === false) {
      const parsed = parseDatabaseUrl(resolveSafeDedicatedTestDatabaseUrl());
      assert.notEqual(parsed.database.toLowerCase(), 'roomies');
      assert.match(parsed.database, /(?:^|_)(?:test|ci)$/i);
    }
  });

  void it(
    'shares one dispatcher transaction in both orders and retries each opposite handler failure exactly once',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixtures: Fixture[] = [];
      const finalSnapshots: Awaited<ReturnType<typeof projectionCounts>>[] = [];
      try {
        for (const failure of ['notifications', 'activity'] as const) {
          const fixture = await createFixture(database.pool, {
            name: `M7.2 ${failure} rollback`,
          });
          fixtures.push(fixture);
          const liveActivity = createActivityOutboxHandlerFromPool(
            database.pool,
          );
          const livePersistence = createNotificationPersistenceFromPool(
            database.pool,
          );
          let failOnce = true;

          let handlers: readonly OutboxEventHandler[];
          if (failure === 'notifications') {
            const middleFailingPersistence: NotificationPersistence =
              Object.freeze({
                insertNotification: (tx, row) =>
                  livePersistence.insertNotification(tx, row),
                findBySourceRecipientKind: (tx, key) =>
                  livePersistence.findBySourceRecipientKind(tx, key),
                async insertNotifications(tx, rows) {
                  if (failOnce) {
                    failOnce = false;
                    const first = rows[0];
                    assert.ok(first);
                    await livePersistence.insertNotification(tx, first);
                    throw new NotificationPersistenceError();
                  }
                  return livePersistence.insertNotifications(tx, rows);
                },
              });
            handlers = [
              liveActivity,
              notificationHandler(database.pool, {
                notifications: middleFailingPersistence,
              }),
            ];
          } else {
            const failingActivity: OutboxEventHandler = Object.freeze({
              handlerId: liveActivity.handlerId,
              eventTypes: liveActivity.eventTypes,
              async handle(tx, event) {
                await liveActivity.handle(tx, event);
                if (failOnce) {
                  failOnce = false;
                  throw new ActivityProjectionIntegrityError();
                }
              },
            });
            handlers = [
              createNotificationOutboxHandlerFromPool(database.pool),
              failingActivity,
            ];
          }

          const dispatcher = consumer(database.pool, handlers);
          const first = await dispatcher.drain({ batchSize: 1 });
          assert.deepEqual(first, {
            processedCount: 0,
            failedCount: 1,
            moreWorkLikely: true,
          });
          await assertFailureRolledBack(database.pool, fixture);

          const retry = await dispatcher.drain({ batchSize: 1 });
          assert.deepEqual(retry, {
            processedCount: 1,
            failedCount: 0,
            moreWorkLikely: true,
          });
          const finalState = await outboxState(
            database.pool,
            fixture.createdEventId,
          );
          assert.ok(finalState.processed_at);
          assert.equal(finalState.attempt_count, 1);
          const snapshot = await projectionCounts(
            database.pool,
            fixture.homeId,
          );
          assert.deepEqual(snapshot, {
            activities: 1,
            activityRecipients: 3,
            notifications: 2,
            kinds: [
              'PRIVATE_MAINTENANCE_CREATED',
              'PRIVATE_MAINTENANCE_CREATED',
            ],
          });
          finalSnapshots.push(snapshot);
        }
        assert.deepEqual(finalSnapshots[0], finalSnapshots[1]);
      } finally {
        await cleanup(database.pool, {
          homeIds: fixtures.map((fixture) => fixture.homeId),
          userIds: fixtures.flatMap((fixture) => [...fixture.userIds]),
        });
        await database.close();
      }
    },
  );

  void it(
    'does not backfill a Notification for an event processed before later handler registration',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixture = await createFixture(database.pool, {
        name: 'M7.2 terminal processed marker',
      });
      try {
        const activityOnly = consumer(database.pool, [
          createActivityOutboxHandlerFromPool(database.pool),
        ]);
        assert.equal(
          (await activityOnly.drain({ batchSize: 1 })).processedCount,
          1,
        );
        const processedAt = (
          await outboxState(database.pool, fixture.createdEventId)
        ).processed_at;
        assert.ok(processedAt);

        const laterDeployment = consumer(database.pool, [
          createActivityOutboxHandlerFromPool(database.pool),
          createNotificationOutboxHandlerFromPool(database.pool),
        ]);
        assert.deepEqual(await laterDeployment.drain({ batchSize: 5 }), {
          processedCount: 0,
          failedCount: 0,
          moreWorkLikely: false,
        });
        assert.deepEqual(
          (await outboxState(database.pool, fixture.createdEventId))
            .processed_at,
          processedAt,
        );
        assert.equal(
          (
            await database.pool.query(
              'SELECT id FROM notifications WHERE home_id = $1',
              [fixture.homeId],
            )
          ).rows.length,
          0,
        );
      } finally {
        await cleanup(database.pool, {
          homeIds: [fixture.homeId],
          userIds: fixture.userIds,
        });
        await database.close();
      }
    },
  );

  void it(
    'projects delayed private create and resolve as distinct Notifications from immutable event times',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixture = await createFixture(database.pool, {
        name: 'M7.2 delayed create resolve',
        resolved: true,
      });
      try {
        const dispatcher = consumer(database.pool, [
          createActivityOutboxHandlerFromPool(database.pool),
          createNotificationOutboxHandlerFromPool(database.pool),
        ]);
        const result = await dispatcher.drain({ batchSize: 5 });
        assert.equal(result.processedCount, 2);
        assert.equal(result.failedCount, 0);

        const rows = await database.pool.query<{
          source_outbox_event_id: string;
          kind: string;
          recipient_membership_id: string;
          occurred_at: Date;
        }>(
          `SELECT source_outbox_event_id, kind, recipient_membership_id,
                  occurred_at
           FROM notifications
           WHERE home_id = $1
           ORDER BY source_outbox_event_id, recipient_membership_id`,
          [fixture.homeId],
        );
        const created = rows.rows.filter(
          (row) => row.source_outbox_event_id === fixture.createdEventId,
        );
        const resolved = rows.rows.filter(
          (row) => row.source_outbox_event_id === fixture.resolvedEventId,
        );
        assert.deepEqual(
          created.map((row) => row.recipient_membership_id).sort(),
          [
            fixture.firstRecipientMembershipId,
            fixture.secondRecipientMembershipId,
          ].sort(),
        );
        assert.deepEqual(
          resolved.map((row) => row.recipient_membership_id).sort(),
          [
            fixture.actorMembershipId,
            fixture.firstRecipientMembershipId,
          ].sort(),
        );
        assert.equal(
          created.every(
            (row) =>
              row.kind === 'PRIVATE_MAINTENANCE_CREATED' &&
              row.occurred_at.getTime() === CREATED_AT.getTime(),
          ),
          true,
        );
        assert.equal(
          resolved.every(
            (row) =>
              row.kind === 'PRIVATE_MAINTENANCE_RESOLVED' &&
              row.occurred_at.getTime() === RESOLVED_AT.getTime(),
          ),
          true,
        );
        assert.equal(rows.rows.length, 4);
        assert.deepEqual(
          await projectionCounts(database.pool, fixture.homeId),
          {
            activities: 2,
            activityRecipients: 6,
            notifications: 4,
            kinds: [
              'PRIVATE_MAINTENANCE_CREATED',
              'PRIVATE_MAINTENANCE_CREATED',
              'PRIVATE_MAINTENANCE_RESOLVED',
              'PRIVATE_MAINTENANCE_RESOLVED',
            ],
          },
        );
      } finally {
        await cleanup(database.pool, {
          homeIds: [fixture.homeId],
          userIds: fixture.userIds,
        });
        await database.close();
      }
    },
  );

  void it(
    'keeps a delayed Notification bound to the exact ended tenure after the user rejoins',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const homeId = randomUUID();
      const actorUserId = randomUUID();
      const rejoiningUserId = randomUUID();
      const actorMembershipId = randomUUID();
      const endedMembershipId = randomUUID();
      const rejoinedMembershipId = randomUUID();
      const maintenanceEntryId = randomUUID();
      const eventId = randomUUID();
      try {
        await insertUser(database.pool, actorUserId);
        await insertUser(database.pool, rejoiningUserId);
        await insertHome(database.pool, homeId, 'M7.2 exact tenure rejoin');
        await insertMembership(database.pool, {
          id: actorMembershipId,
          homeId,
          userId: actorUserId,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: endedMembershipId,
          homeId,
          userId: rejoiningUserId,
          role: 'ROOMMATE',
          endedAt: ENDING_AT,
          endedByMembershipId: actorMembershipId,
        });
        await insertMembership(database.pool, {
          id: rejoinedMembershipId,
          homeId,
          userId: rejoiningUserId,
          role: 'ROOMMATE',
          joinedAt: new Date(ENDING_AT.getTime() + 1),
        });
        await insertMaintenance(database.pool, {
          id: maintenanceEntryId,
          homeId,
          actorMembershipId,
          audienceMembershipIds: [actorMembershipId, endedMembershipId],
          createdAt: CREATED_AT,
        });
        await insertMaintenanceEvent(database.pool, {
          eventId,
          eventType: MAINTENANCE_CREATED_V1,
          homeId,
          maintenanceEntryId,
          occurredAt: CREATED_AT,
        });

        const result = await consumer(database.pool, [
          createNotificationOutboxHandlerFromPool(database.pool),
        ]).drain({ batchSize: 1 });
        assert.equal(result.processedCount, 1);
        assert.ok((await outboxState(database.pool, eventId)).processed_at);
        const rows = await database.pool.query<{
          recipient_membership_id: string;
        }>(
          `SELECT recipient_membership_id FROM notifications
           WHERE home_id = $1`,
          [homeId],
        );
        assert.equal(
          rows.rows.some(
            (row) => row.recipient_membership_id === rejoinedMembershipId,
          ),
          false,
        );
        assert.deepEqual(rows.rows, []);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [actorUserId, rejoiningUserId],
        });
        await database.close();
      }
    },
  );

  void it(
    'lets Notification projection win the Home lock before Membership ending without resurrection',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixture = await createFixture(database.pool, {
        name: 'M7.2 handler wins ending race',
      });
      const handlerLocked = deferred();
      const handlerMayCommit = deferred();
      const endingPid = deferred<number>();
      try {
        const handler = notificationHandler(database.pool, {
          async lockHomeAndExactMemberships(tx, input) {
            const locked = await lockHomeAndExactMemberships(tx, input);
            handlerLocked.resolve();
            await handlerMayCommit.promise;
            return locked;
          },
        });
        const drain = consumer(database.pool, [handler]).drain({
          batchSize: 1,
        });
        await handlerLocked.promise;
        const ending = endMembership(database.pool, fixture, {
          capturePid: (pid) => endingPid.resolve(pid),
        });
        const pid = await endingPid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));

        handlerMayCommit.resolve();
        assert.equal((await drain).processedCount, 1);
        await ending;
        await assertRaceFinal(database.pool, fixture);
      } finally {
        handlerMayCommit.resolve();
        await cleanup(database.pool, {
          homeIds: [fixture.homeId],
          userIds: fixture.userIds,
        });
        await database.close();
      }
    },
  );

  void it(
    'lets Membership ending win the Home lock before Notification projection without resurrection',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixture = await createFixture(database.pool, {
        name: 'M7.2 ending wins handler race',
      });
      const endingLocked = deferred();
      const endingMayCommit = deferred();
      const handlerPid = deferred<number>();
      try {
        const ending = endMembership(database.pool, fixture, {
          afterLock: async () => {
            endingLocked.resolve();
            await endingMayCommit.promise;
          },
        });
        await endingLocked.promise;

        const handler = notificationHandler(database.pool, {
          async lockHomeAndExactMemberships(tx, input) {
            handlerPid.resolve(await backendPid(tx));
            return lockHomeAndExactMemberships(tx, input);
          },
        });
        const drain = consumer(database.pool, [handler]).drain({
          batchSize: 1,
        });
        const pid = await handlerPid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));

        endingMayCommit.resolve();
        await ending;
        assert.equal((await drain).processedCount, 1);
        await assertRaceFinal(database.pool, fixture);
      } finally {
        endingMayCommit.resolve();
        await cleanup(database.pool, {
          homeIds: [fixture.homeId],
          userIds: fixture.userIds,
        });
        await database.close();
      }
    },
  );
});
