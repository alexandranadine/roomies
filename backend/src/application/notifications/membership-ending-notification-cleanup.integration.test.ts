import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createArchiveFinalMemberHomeFromPool } from '../home-administration/archive-final-member-home.js';
import { createEndMembershipWithinHomeStructureFromPool } from '../home-administration/end-membership-within-home-structure.js';
import { lockHomeStructure } from '../../domains/homes/lock-home-structure.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import type { AppConfig } from '../../platform/config/types.js';
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import {
  createNotificationRepository,
  type NewNotification,
} from '../../domains/notifications/repository.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const ENDED_AT = new Date('2026-03-15T12:34:56.789Z');
const CREATED = new Date('2026-03-01T00:00:00.000Z');
const OCCURRED = new Date('2026-03-01T00:00:00.000Z');

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
  input: { id: string; name: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO homes (id, name, timezone, updated_at)
     VALUES ($1, $2, 'UTC', NOW())`,
    [input.id, input.name],
  );
}

async function insertMembership(
  pool: Pool,
  input: {
    id: string;
    homeId: string;
    userId: string;
    role: 'ROOMMATE' | 'ADMIN';
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO memberships (id, home_id, user_id, role, ended_at, ended_by_membership_id)
     VALUES ($1, $2, $3, $4, NULL, NULL)`,
    [input.id, input.homeId, input.userId, input.role],
  );
}

function notification(
  homeId: string,
  recipientMembershipId: string,
  overrides: Partial<NewNotification> = {},
): NewNotification {
  return {
    id: overrides.id ?? createUuidV7(),
    homeId,
    recipientMembershipId,
    sourceOutboxEventId: overrides.sourceOutboxEventId ?? createUuidV7(),
    kind: overrides.kind ?? 'ASSIGNED_TASK_COMPLETED',
    sourceEntityType: overrides.sourceEntityType ?? 'TASK',
    sourceEntityId: overrides.sourceEntityId ?? createUuidV7(),
    actorMembershipId:
      overrides.actorMembershipId === undefined
        ? null
        : overrides.actorMembershipId,
    occurredAt: overrides.occurredAt ?? OCCURRED,
    createdAt: overrides.createdAt ?? CREATED,
  };
}

async function cleanup(
  pool: Pool,
  input: { homeIds: string[]; userIds: string[] },
): Promise<void> {
  await pool.query(
    'DELETE FROM notifications WHERE home_id = ANY($1::uuid[])',
    [input.homeIds],
  );
  await pool.query(
    'DELETE FROM outbox_events WHERE home_id = ANY($1::uuid[])',
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
  const remaining = await pool.query<{ id: string }>(
    'SELECT id FROM memberships WHERE home_id = ANY($1::uuid[])',
    [input.homeIds],
  );
  for (const row of remaining.rows) {
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
  await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
    input.userIds,
  ]);
}

void describe('membership-ending Notification cleanup integration', () => {
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
    'deletes exact recipient rows in the structural transaction and preserves actor-only, cross-Home, and rejoin isolation',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const notifications = createNotificationRepository(database.pool);
      const endMembership = createEndMembershipWithinHomeStructureFromPool(
        database.pool,
      );
      const homeA = createUuidV7();
      const homeB = createUuidV7();
      const userA = createUuidV7();
      const userB = createUuidV7();
      const userHomeB = createUuidV7();
      const adminA = createUuidV7();
      const memberA = createUuidV7();
      const memberB = createUuidV7();
      const memberHomeB = createUuidV7();
      const addressedToA = createUuidV7();
      const actorOnly = createUuidV7();
      const crossHome = createUuidV7();
      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertUser(database.pool, userHomeB);
        await insertHome(database.pool, { id: homeA, name: 'Home A' });
        await insertHome(database.pool, { id: homeB, name: 'Home B' });
        await insertMembership(database.pool, {
          id: adminA,
          homeId: homeA,
          userId: userB,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: memberA,
          homeId: homeA,
          userId: userA,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: memberHomeB,
          homeId: homeB,
          userId: userHomeB,
          role: 'ADMIN',
        });

        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await notifications.insertNotifications(tx, [
            notification(homeA, memberA, {
              id: addressedToA,
              actorMembershipId: adminA,
            }),
            notification(homeA, adminA, {
              id: actorOnly,
              actorMembershipId: memberA,
              kind: 'CREATED_SUPPLY_OBTAINED',
              sourceEntityType: 'SUPPLY',
            }),
            notification(homeB, memberHomeB, { id: crossHome }),
          ]);
        });

        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await lockHomeStructure(tx, {
            homeId: homeA,
            actor: actor({
              userId: userB,
              membershipId: adminA,
              homeId: homeA,
              role: 'ADMIN',
            }),
          });
          await endMembership(tx, {
            homeId: homeA,
            membershipId: memberA,
            endedAt: ENDED_AT,
            endedByMembershipId: adminA,
            cause: 'ADMIN_REMOVAL',
          });
        });

        const remainingAddressed = await database.pool.query<{ id: string }>(
          'SELECT id FROM notifications WHERE id = $1',
          [addressedToA],
        );
        assert.equal(remainingAddressed.rows.length, 0);
        const survivingActor = await database.pool.query<{
          id: string;
          recipient_membership_id: string;
        }>(
          'SELECT id, recipient_membership_id FROM notifications WHERE id = $1',
          [actorOnly],
        );
        assert.equal(survivingActor.rows[0]?.recipient_membership_id, adminA);
        const survivingCross = await database.pool.query<{ id: string }>(
          'SELECT id FROM notifications WHERE id = $1',
          [crossHome],
        );
        assert.equal(survivingCross.rows[0]?.id, crossHome);

        await insertMembership(database.pool, {
          id: memberB,
          homeId: homeA,
          userId: userA,
          role: 'ROOMMATE',
        });
        const leftoverA = await database.pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM notifications
           WHERE recipient_membership_id = $1`,
          [memberA],
        );
        assert.equal(leftoverA.rows[0]?.count, '0');
        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await notifications.insertNotification(
            tx,
            notification(homeA, memberB, { actorMembershipId: adminA }),
          );
        });
        const rejoined = await database.pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM notifications
           WHERE recipient_membership_id = $1`,
          [memberB],
        );
        assert.equal(rejoined.rows[0]?.count, '1');
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeA, homeB],
          userIds: [userA, userB, userHomeB],
        });
        await database.close();
      }
    },
  );

  void it(
    'rolls Notification cleanup back when a later membership-ending step fails',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const notifications = createNotificationRepository(database.pool);
      const { createEndMembershipWithinHomeStructure } =
        await import('../home-administration/end-membership-within-home-structure.js');
      const { createMembershipEndingTaskCleanupFromPool } =
        await import('../tasks/membership-ending-task-cleanup.js');
      const { createMembershipEndingSupplyCleanupFromPool } =
        await import('../supplies/membership-ending-supply-cleanup.js');
      const { createMembershipEndingNotificationCleanupFromPool } =
        await import('./membership-ending-notification-cleanup.js');
      const { createMembershipEndingWriter } =
        await import('../../domains/memberships/update-active-membership-ended-at.js');
      const homeId = createUuidV7();
      const userA = createUuidV7();
      const userB = createUuidV7();
      const admin = createUuidV7();
      const leaving = createUuidV7();
      const notificationId = createUuidV7();
      const sourceOutboxEventId = createUuidV7();
      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeId, name: 'Rollback home' });
        await insertMembership(database.pool, {
          id: admin,
          homeId,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: leaving,
          homeId,
          userId: userB,
          role: 'ROOMMATE',
        });
        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await notifications.insertNotification(
            tx,
            notification(homeId, leaving, {
              id: notificationId,
              sourceOutboxEventId,
            }),
          );
        });

        const endMembership = createEndMembershipWithinHomeStructure({
          taskCleanup: createMembershipEndingTaskCleanupFromPool(database.pool),
          supplyCleanup: createMembershipEndingSupplyCleanupFromPool(
            database.pool,
          ),
          notificationCleanup:
            createMembershipEndingNotificationCleanupFromPool(database.pool),
          membershipEnding: createMembershipEndingWriter(),
          outbox: {
            append() {
              return Promise.reject(new Error('injected outbox failure'));
            },
          },
          ids: { next: () => createUuidV7() },
        });

        await assert.rejects(
          () =>
            runInReadCommittedTransaction(database.pool, async (tx) => {
              await lockHomeStructure(tx, {
                homeId,
                actor: actor({
                  userId: userA,
                  membershipId: admin,
                  homeId,
                  role: 'ADMIN',
                }),
              });
              await endMembership(tx, {
                homeId,
                membershipId: leaving,
                endedAt: ENDED_AT,
                endedByMembershipId: admin,
                cause: 'ADMIN_REMOVAL',
              });
            }),
          /injected outbox failure/,
        );

        const restored = await runInReadCommittedTransaction(
          database.pool,
          (tx) =>
            notifications.findBySourceRecipientKind(tx, {
              sourceOutboxEventId,
              recipientMembershipId: leaving,
              kind: 'ASSIGNED_TASK_COMPLETED',
            }),
        );
        assert.equal(restored?.id, notificationId);
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
    'final-member archive performs exact-recipient Notification cleanup',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const archive = createArchiveFinalMemberHomeFromPool(database.pool);
      const homeId = createUuidV7();
      const userId = createUuidV7();
      const membershipId = createUuidV7();
      const notificationId = createUuidV7();
      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, { id: homeId, name: 'Final home' });
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ADMIN',
        });
        const notifications = createNotificationRepository(database.pool);
        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await notifications.insertNotification(
            tx,
            notification(homeId, membershipId, { id: notificationId }),
          );
        });

        await archive({
          homeId,
          actor: actor({
            userId,
            membershipId,
            homeId,
            role: 'ADMIN',
          }),
        });

        const remaining = await database.pool.query<{ id: string }>(
          'SELECT id FROM notifications WHERE id = $1',
          [notificationId],
        );
        assert.equal(remaining.rows.length, 0);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userId],
        });
        await database.close();
      }
    },
  );
});
