import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import type { AppConfig } from '../../platform/config/types.js';
import { NotificationPersistenceError } from './errors.js';
import {
  NOTIFICATION_KIND_SOURCE_TYPE,
  type NotificationKind,
} from './notification.js';
import {
  createNotificationRepository,
  NOTIFICATION_PRUNE_BATCH_SIZE,
  type NewNotification,
} from './repository.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const CREATED = new Date('2026-09-13T12:00:00.000Z');
const OCCURRED = new Date('2026-09-13T11:00:00.000Z');
const CUTOFF = new Date('2026-06-15T00:00:00.000Z');

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

async function insertUser(pool: Pool, userId: string): Promise<void> {
  await pool.query('INSERT INTO users (id, updated_at) VALUES ($1, NOW())', [
    userId,
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

function row(
  homeId: string,
  recipientMembershipId: string,
  overrides: Partial<NewNotification> = {},
): NewNotification {
  const kind = overrides.kind ?? 'PRIVATE_MAINTENANCE_CREATED';
  return {
    id: overrides.id ?? createUuidV7(),
    homeId,
    recipientMembershipId,
    sourceOutboxEventId: overrides.sourceOutboxEventId ?? createUuidV7(),
    kind,
    sourceEntityType:
      overrides.sourceEntityType ?? NOTIFICATION_KIND_SOURCE_TYPE[kind],
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
  input: { userIds: string[]; homeIds: string[] },
): Promise<void> {
  if (input.homeIds.length > 0) {
    await pool.query(
      'DELETE FROM notifications WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query(
      'DELETE FROM memberships WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
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

void describe('Notification repository PostgreSQL', () => {
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
    'inserts, deduplicates, cleans up, and prunes without swallowing unrelated errors',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const notifications = createNotificationRepository(database.pool);
      const users = [createUuidV7(), createUuidV7(), createUuidV7()] as const;
      const homeA = createUuidV7();
      const homeB = createUuidV7();
      const memberA = createUuidV7();
      const memberB = createUuidV7();
      const memberHomeB = createUuidV7();
      try {
        await insertUser(database.pool, users[0]);
        await insertUser(database.pool, users[1]);
        await insertUser(database.pool, users[2]);
        await insertHome(database.pool, { id: homeA, name: 'Home A' });
        await insertHome(database.pool, { id: homeB, name: 'Home B' });
        await insertMembership(database.pool, {
          id: memberA,
          homeId: homeA,
          userId: users[0],
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: memberB,
          homeId: homeA,
          userId: users[1],
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: memberHomeB,
          homeId: homeB,
          userId: users[2],
          role: 'ADMIN',
        });

        await runInReadCommittedTransaction(database.pool, async (tx) => {
          const one = row(homeA, memberA, {
            kind: 'MEMBERSHIP_ROLE_CHANGED',
            actorMembershipId: memberB,
          });
          const inserted = await notifications.insertNotification(tx, one);
          assert.equal(inserted.outcome, 'inserted');
          if (inserted.outcome === 'inserted') {
            assert.equal(inserted.notification.recipientMembershipId, memberA);
            assert.equal(inserted.notification.actorMembershipId, memberB);
            assert.equal(inserted.notification.readAt, null);
          }

          const eventId = createUuidV7();
          const supplyId = createUuidV7();
          const batch = await notifications.insertNotifications(tx, [
            row(homeA, memberA, {
              sourceOutboxEventId: eventId,
              kind: 'CREATED_SUPPLY_OBTAINED',
              sourceEntityId: supplyId,
            }),
            row(homeA, memberB, {
              sourceOutboxEventId: eventId,
              kind: 'CREATED_SUPPLY_OBTAINED',
              sourceEntityId: supplyId,
            }),
          ]);
          assert.equal(batch.length, 2);
          assert.equal(batch[0]?.outcome, 'inserted');
          assert.equal(batch[1]?.outcome, 'inserted');

          const foundA = await notifications.findBySourceRecipientKind(tx, {
            sourceOutboxEventId: eventId,
            recipientMembershipId: memberA,
            kind: 'CREATED_SUPPLY_OBTAINED',
          });
          const foundB = await notifications.findBySourceRecipientKind(tx, {
            sourceOutboxEventId: eventId,
            recipientMembershipId: memberB,
            kind: 'CREATED_SUPPLY_OBTAINED',
          });
          assert.equal(foundA?.recipientMembershipId, memberA);
          assert.equal(foundB?.recipientMembershipId, memberB);

          const maintenanceEvent = createUuidV7();
          const maintenanceId = createUuidV7();
          const createdKind: NotificationKind = 'PRIVATE_MAINTENANCE_CREATED';
          const resolvedKind: NotificationKind = 'PRIVATE_MAINTENANCE_RESOLVED';
          assert.equal(
            (
              await notifications.insertNotification(
                tx,
                row(homeA, memberA, {
                  sourceOutboxEventId: maintenanceEvent,
                  kind: createdKind,
                  sourceEntityId: maintenanceId,
                }),
              )
            ).outcome,
            'inserted',
          );
          assert.equal(
            (
              await notifications.insertNotification(
                tx,
                row(homeA, memberA, {
                  sourceOutboxEventId: maintenanceEvent,
                  kind: resolvedKind,
                  sourceEntityId: maintenanceId,
                }),
              )
            ).outcome,
            'inserted',
          );

          const first = row(homeA, memberA, {
            kind: 'ASSIGNED_TASK_COMPLETED',
          });
          assert.equal(
            (await notifications.insertNotification(tx, first)).outcome,
            'inserted',
          );
          const duplicate = await notifications.insertNotification(tx, {
            ...first,
            id: createUuidV7(),
            createdAt: new Date('2026-09-14T00:00:00.000Z'),
          });
          assert.deepEqual(duplicate, {
            outcome: 'duplicate_source_recipient_kind',
            sourceOutboxEventId: first.sourceOutboxEventId,
            recipientMembershipId: memberA,
            kind: 'ASSIGNED_TASK_COMPLETED',
          });

          await assert.rejects(
            () =>
              notifications.insertNotification(
                tx,
                row(homeA, memberHomeB, {
                  kind: 'ASSIGNED_TASK_COMPLETED',
                }),
              ),
            NotificationPersistenceError,
          );
          await assert.rejects(
            () =>
              notifications.insertNotification(
                tx,
                row(homeA, memberA, {
                  kind: 'ASSIGNED_TASK_COMPLETED',
                  actorMembershipId: memberHomeB,
                }),
              ),
            NotificationPersistenceError,
          );
          await assert.rejects(
            () =>
              notifications.insertNotification(
                tx,
                row(homeA, memberA, {
                  kind: 'MEMBERSHIP_ROLE_CHANGED',
                  sourceEntityType: 'TASK',
                }),
              ),
            NotificationPersistenceError,
          );

          const nullable = await notifications.insertNotification(
            tx,
            row(homeA, memberB, {
              kind: 'CREATED_SUPPLY_OBTAINED',
              actorMembershipId: null,
            }),
          );
          assert.equal(nullable.outcome, 'inserted');
          if (nullable.outcome === 'inserted') {
            assert.equal(nullable.notification.actorMembershipId, null);
          }

          const recipientOnly = row(homeA, memberA, {
            kind: 'PRIVATE_MAINTENANCE_CREATED',
            actorMembershipId: memberB,
          });
          const actorOnly = row(homeA, memberB, {
            kind: 'PRIVATE_MAINTENANCE_RESOLVED',
            actorMembershipId: memberA,
          });
          await notifications.insertNotification(tx, recipientOnly);
          await notifications.insertNotification(tx, actorOnly);
          const deletedRecipients =
            await notifications.deleteByRecipientMembership(tx, {
              homeId: homeA,
              recipientMembershipId: memberA,
            });
          assert.ok(deletedRecipients >= 1);
          assert.equal(
            await notifications.findBySourceRecipientKind(tx, {
              sourceOutboxEventId: recipientOnly.sourceOutboxEventId,
              recipientMembershipId: memberA,
              kind: recipientOnly.kind,
            }),
            null,
          );
          assert.equal(
            (
              await notifications.findBySourceRecipientKind(tx, {
                sourceOutboxEventId: actorOnly.sourceOutboxEventId,
                recipientMembershipId: memberB,
                kind: actorOnly.kind,
              })
            )?.id,
            actorOnly.id,
          );

          const sourceA = createUuidV7();
          const sourceB = createUuidV7();
          await notifications.insertNotification(
            tx,
            row(homeA, memberB, {
              kind: 'PRIVATE_MAINTENANCE_CREATED',
              sourceEntityId: sourceA,
            }),
          );
          await notifications.insertNotification(
            tx,
            row(homeB, memberHomeB, {
              kind: 'PRIVATE_MAINTENANCE_CREATED',
              sourceEntityId: sourceA,
            }),
          );
          const supplyKept = row(homeA, memberB, {
            kind: 'CREATED_SUPPLY_OBTAINED',
            sourceEntityId: sourceB,
          });
          await notifications.insertNotification(tx, supplyKept);
          assert.equal(
            await notifications.deleteBySource(tx, {
              homeId: homeA,
              sourceEntityType: 'MAINTENANCE',
              sourceEntityId: sourceA,
            }),
            1,
          );
          assert.ok(
            await notifications.findBySourceRecipientKind(tx, {
              sourceOutboxEventId: supplyKept.sourceOutboxEventId,
              recipientMembershipId: memberB,
              kind: 'CREATED_SUPPLY_OBTAINED',
            }),
          );

          const older = row(homeA, memberB, {
            kind: 'ASSIGNED_TASK_COMPLETED',
            occurredAt: new Date('2026-03-01T00:00:00.000Z'),
          });
          const atCutoff = row(homeA, memberB, {
            kind: 'ASSIGNED_TASK_COMPLETED',
            occurredAt: CUTOFF,
          });
          const newer = row(homeA, memberB, {
            kind: 'ASSIGNED_TASK_COMPLETED',
            occurredAt: new Date('2026-07-01T00:00:00.000Z'),
          });
          await notifications.insertNotifications(tx, [older, atCutoff, newer]);
          const pruned = await notifications.pruneExpired(tx, {
            cutoff: CUTOFF,
            limit: NOTIFICATION_PRUNE_BATCH_SIZE,
          });
          assert.ok(pruned.deletedCount >= 1);
          assert.ok(pruned.ids.includes(older.id));
          assert.equal(pruned.ids.includes(atCutoff.id), false);
          assert.equal(pruned.ids.includes(newer.id), false);

          const boundedIds = [
            createUuidV7(),
            createUuidV7(),
            createUuidV7(),
          ].sort();
          const oldOccurred = new Date('2026-01-01T00:00:00.000Z');
          await notifications.insertNotifications(
            tx,
            boundedIds.map((id) =>
              row(homeA, memberB, {
                id,
                kind: 'MEMBERSHIP_ROLE_CHANGED',
                occurredAt: oldOccurred,
              }),
            ),
          );
          const bounded = await notifications.pruneExpired(tx, {
            cutoff: CUTOFF,
            limit: 2,
          });
          assert.equal(bounded.deletedCount, 2);
          assert.deepEqual([...bounded.ids], boundedIds.slice(0, 2));

          const historicalA = row(homeA, memberA, {
            kind: 'CREATED_SUPPLY_OBTAINED',
          });
          await notifications.insertNotification(tx, historicalA);
          await notifications.deleteByRecipientMembership(tx, {
            homeId: homeA,
            recipientMembershipId: memberB,
          });
          assert.equal(
            (
              await notifications.findBySourceRecipientKind(tx, {
                sourceOutboxEventId: historicalA.sourceOutboxEventId,
                recipientMembershipId: memberA,
                kind: historicalA.kind,
              })
            )?.id,
            historicalA.id,
          );
        });
      } finally {
        await cleanup(database.pool, {
          userIds: [...users],
          homeIds: [homeA, homeB],
        });
        await database.close();
      }
    },
  );
});
