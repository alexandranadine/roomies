import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createActivityRepository } from '../../domains/activity/repository.js';
import { ActivityPersistenceError } from '../../domains/activity/errors.js';
import { createMaintenanceRepository } from '../../domains/maintenance/repository.js';
import { createNotificationRepository } from '../../domains/notifications/repository.js';
import type { AppConfig } from '../../platform/config/types.js';
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import { createDeleteActivitiesForSource } from '../activity/delete-activities-for-source.js';
import { createDeleteNotificationsForSourceFromPool } from '../notifications/delete-notifications-for-source.js';
import { createEraseAuthoredMaintenance } from './erase-authored-maintenance.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const CREATED = new Date('2026-09-14T15:00:00.000Z');

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

async function insertUser(pool: Pool, id: string): Promise<void> {
  await pool.query('INSERT INTO users (id, updated_at) VALUES ($1, NOW())', [
    id,
  ]);
}

async function insertHome(pool: Pool, id: string): Promise<void> {
  await pool.query(
    `INSERT INTO homes (id, name, timezone, archived_at, updated_at)
     VALUES ($1, 'Failure home', 'UTC', NULL, NOW())`,
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
  userA: string;
  userB: string;
  author: string;
  audience: string;
  entryId: string;
  activityId: string;
  notificationId: string;
};

async function seed(pool: Pool): Promise<Fixture> {
  const fixture: Fixture = {
    homeId: createUuidV7(),
    userA: randomUUID(),
    userB: randomUUID(),
    author: createUuidV7(),
    audience: createUuidV7(),
    entryId: createUuidV7(),
    activityId: createUuidV7(),
    notificationId: createUuidV7(),
  };
  await insertUser(pool, fixture.userA);
  await insertUser(pool, fixture.userB);
  await insertHome(pool, fixture.homeId);
  await insertMembership(pool, {
    id: fixture.author,
    homeId: fixture.homeId,
    userId: fixture.userA,
  });
  await insertMembership(pool, {
    id: fixture.audience,
    homeId: fixture.homeId,
    userId: fixture.userB,
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
        visibility: 'PRIVATE',
        title: 'Failure source',
        details: null,
        status: 'OPEN',
        resolvedByMembershipId: null,
        resolvedAt: null,
        createdAt: CREATED,
        updatedAt: CREATED,
      },
      audienceMembershipIds: [fixture.author, fixture.audience],
    });
    await activity.insertSourceAuthorizedActivity(
      tx,
      {
        id: fixture.activityId,
        homeId: fixture.homeId,
        sourceOutboxEventId: createUuidV7(),
        sourceEntityType: 'MAINTENANCE',
        sourceEntityId: fixture.entryId,
        eventType: 'maintenance.created.v1',
        actorMembershipId: fixture.author,
        occurredAt: CREATED,
        createdAt: CREATED,
      },
      [fixture.author, fixture.audience],
    );
    await notifications.insertNotification(tx, {
      id: fixture.notificationId,
      homeId: fixture.homeId,
      recipientMembershipId: fixture.audience,
      sourceOutboxEventId: createUuidV7(),
      kind: 'PRIVATE_MAINTENANCE_CREATED',
      sourceEntityType: 'MAINTENANCE',
      sourceEntityId: fixture.entryId,
      actorMembershipId: fixture.author,
      occurredAt: CREATED,
      createdAt: CREATED,
      readAt: null,
    });
  });
  return fixture;
}

async function assertIntact(pool: Pool, fixture: Fixture): Promise<void> {
  const entry = await pool.query<{ id: string }>(
    'SELECT id FROM maintenance_entries WHERE id = $1',
    [fixture.entryId],
  );
  const audience = await pool.query<{ membership_id: string }>(
    `SELECT membership_id FROM maintenance_audiences
     WHERE maintenance_entry_id = $1`,
    [fixture.entryId],
  );
  const activity = await pool.query<{ id: string }>(
    'SELECT id FROM activities WHERE id = $1',
    [fixture.activityId],
  );
  const recipients = await pool.query<{ membership_id: string }>(
    'SELECT membership_id FROM activity_recipients WHERE activity_id = $1',
    [fixture.activityId],
  );
  const notification = await pool.query<{ id: string }>(
    'SELECT id FROM notifications WHERE id = $1',
    [fixture.notificationId],
  );
  assert.equal(entry.rows.length, 1);
  assert.equal(audience.rows.length, 2);
  assert.equal(activity.rows.length, 1);
  assert.equal(recipients.rows.length, 2);
  assert.equal(notification.rows.length, 1);
}

void describe('Maintenance erasure failure rollback PostgreSQL', () => {
  void it(
    'rolls back when notification deletion is followed by failure',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixture = await seed(database.pool);
      const maintenance = createMaintenanceRepository(database.pool);
      const erase = createEraseAuthoredMaintenance({
        deleteNotificationsForSource: async (tx, input) => {
          await createDeleteNotificationsForSourceFromPool(database.pool)(
            tx,
            input,
          );
          throw new Error('injected after notifications');
        },
        deleteActivitiesForSource: createDeleteActivitiesForSource(
          createActivityRepository(database.pool),
        ),
        maintenance,
      });
      try {
        await assert.rejects(
          () =>
            runInReadCommittedTransaction(database.pool, async (tx) => {
              await erase(tx, { membershipIds: [fixture.author] });
            }),
          /injected after notifications/,
        );
        await assertIntact(database.pool, fixture);
      } finally {
        await cleanup(database.pool, {
          homeId: fixture.homeId,
          userIds: [fixture.userA, fixture.userB],
        });
        await database.pool.end();
      }
    },
  );

  void it(
    'rolls back when ActivityRecipient deletion is followed by failure',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixture = await seed(database.pool);
      const erase = createEraseAuthoredMaintenance({
        deleteNotificationsForSource:
          createDeleteNotificationsForSourceFromPool(database.pool),
        deleteActivitiesForSource: createDeleteActivitiesForSource(
          createActivityRepository(database.pool),
          {
            afterRecipientsDeleted() {
              throw new Error('injected after recipients');
            },
          },
        ),
        maintenance: createMaintenanceRepository(database.pool),
      });
      try {
        await assert.rejects(
          () =>
            runInReadCommittedTransaction(database.pool, async (tx) => {
              await erase(tx, { membershipIds: [fixture.author] });
            }),
          /injected after recipients/,
        );
        await assertIntact(database.pool, fixture);
      } finally {
        await cleanup(database.pool, {
          homeId: fixture.homeId,
          userIds: [fixture.userA, fixture.userB],
        });
        await database.pool.end();
      }
    },
  );

  void it(
    'rolls back when Activity deletion is followed by failure',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixture = await seed(database.pool);
      const erase = createEraseAuthoredMaintenance({
        deleteNotificationsForSource:
          createDeleteNotificationsForSourceFromPool(database.pool),
        deleteActivitiesForSource: createDeleteActivitiesForSource(
          createActivityRepository(database.pool),
          {
            afterActivitiesDeleted() {
              throw new Error('injected after activities');
            },
          },
        ),
        maintenance: createMaintenanceRepository(database.pool),
      });
      try {
        await assert.rejects(
          () =>
            runInReadCommittedTransaction(database.pool, async (tx) => {
              await erase(tx, { membershipIds: [fixture.author] });
            }),
          /injected after activities/,
        );
        await assertIntact(database.pool, fixture);
      } finally {
        await cleanup(database.pool, {
          homeId: fixture.homeId,
          userIds: [fixture.userA, fixture.userB],
        });
        await database.pool.end();
      }
    },
  );

  void it(
    'rolls back when MaintenanceAudience deletion is followed by failure',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixture = await seed(database.pool);
      const maintenance = createMaintenanceRepository(database.pool);
      const erase = createEraseAuthoredMaintenance({
        deleteNotificationsForSource:
          createDeleteNotificationsForSourceFromPool(database.pool),
        deleteActivitiesForSource: createDeleteActivitiesForSource(
          createActivityRepository(database.pool),
        ),
        maintenance: {
          lockAuthoredSourcesForErase: (tx, input) =>
            maintenance.lockAuthoredSourcesForErase(tx, input),
          deleteAudienceForErasedSource: async (tx, source) => {
            await maintenance.deleteAudienceForErasedSource(tx, source);
            throw new Error('injected after audience');
          },
          deleteAuthoredSource: (tx, source) =>
            maintenance.deleteAuthoredSource(tx, source),
        },
      });
      try {
        await assert.rejects(
          () =>
            runInReadCommittedTransaction(database.pool, async (tx) => {
              await erase(tx, { membershipIds: [fixture.author] });
            }),
          /injected after audience/,
        );
        await assertIntact(database.pool, fixture);
      } finally {
        await cleanup(database.pool, {
          homeId: fixture.homeId,
          userIds: [fixture.userA, fixture.userB],
        });
        await database.pool.end();
      }
    },
  );

  void it(
    'rolls back when MaintenanceEntry deletion is followed by failure before commit',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixture = await seed(database.pool);
      const maintenance = createMaintenanceRepository(database.pool);
      const erase = createEraseAuthoredMaintenance({
        deleteNotificationsForSource:
          createDeleteNotificationsForSourceFromPool(database.pool),
        deleteActivitiesForSource: createDeleteActivitiesForSource(
          createActivityRepository(database.pool),
        ),
        maintenance: {
          lockAuthoredSourcesForErase: (tx, input) =>
            maintenance.lockAuthoredSourcesForErase(tx, input),
          deleteAudienceForErasedSource: (tx, source) =>
            maintenance.deleteAudienceForErasedSource(tx, source),
          deleteAuthoredSource: async (tx, source) => {
            await maintenance.deleteAuthoredSource(tx, source);
            throw new Error('injected after entry');
          },
        },
      });
      try {
        await assert.rejects(
          () =>
            runInReadCommittedTransaction(database.pool, async (tx) => {
              await erase(tx, { membershipIds: [fixture.author] });
            }),
          /injected after entry/,
        );
        await assertIntact(database.pool, fixture);
      } finally {
        await cleanup(database.pool, {
          homeId: fixture.homeId,
          userIds: [fixture.userA, fixture.userB],
        });
        await database.pool.end();
      }
    },
  );

  void it(
    'cannot delete Activity rows while ActivityRecipient rows remain',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixture = await seed(database.pool);
      const activity = createActivityRepository(database.pool);
      try {
        await assert.rejects(
          () =>
            runInReadCommittedTransaction(database.pool, async (tx) => {
              await activity.deleteActivitiesBySource(tx, {
                homeId: fixture.homeId,
                sourceEntityType: 'MAINTENANCE',
                sourceEntityId: fixture.entryId,
              });
            }),
          ActivityPersistenceError,
        );
        await assertIntact(database.pool, fixture);
      } finally {
        await cleanup(database.pool, {
          homeId: fixture.homeId,
          userIds: [fixture.userA, fixture.userB],
        });
        await database.pool.end();
      }
    },
  );
});
