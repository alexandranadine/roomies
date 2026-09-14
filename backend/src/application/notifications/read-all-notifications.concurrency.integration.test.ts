import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { LOCK_EXACT_MEMBERSHIP_FOR_UPDATE_SQL } from '../../domains/homes/lock-home-and-exact-memberships.js';
import { LOCK_HOME_FOR_UPDATE_SQL } from '../../domains/homes/lock-home-structure.js';
import { createMaintenanceRepository } from '../../domains/maintenance/repository.js';
import { NOTIFICATION_KIND_SOURCE_TYPE } from '../../domains/notifications/notification.js';
import {
  createNotificationRepository,
  type NewNotification,
} from '../../domains/notifications/repository.js';
import type { AppConfig } from '../../platform/config/types.js';
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import { createReadAllNotificationsFromPool } from './read-all-notifications.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const CREATED = new Date('2026-09-13T12:00:00.000Z');

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
  input: { id: string; name: string; archived?: boolean },
): Promise<void> {
  await pool.query(
    `INSERT INTO homes (id, name, timezone, archived_at, updated_at)
     VALUES ($1, $2, 'UTC', $3, NOW())`,
    [input.id, input.name, input.archived === true ? new Date() : null],
  );
}

async function insertMembership(
  pool: Pool,
  input: {
    id: string;
    homeId: string;
    userId: string;
    role: 'ROOMMATE' | 'ADMIN';
    ended?: boolean;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO memberships (id, home_id, user_id, role, ended_at, ended_by_membership_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.id,
      input.homeId,
      input.userId,
      input.role,
      input.ended === true ? new Date() : null,
      input.ended === true ? input.id : null,
    ],
  );
}

function row(
  homeId: string,
  recipientMembershipId: string,
  overrides: Partial<NewNotification> = {},
): NewNotification {
  const kind = overrides.kind ?? 'ASSIGNED_TASK_COMPLETED';
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
    occurredAt: overrides.occurredAt ?? CREATED,
    createdAt: overrides.createdAt ?? CREATED,
    readAt: overrides.readAt,
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

async function readAt(pool: Pool, id: string): Promise<Date | null> {
  const result = await pool.query<{ read_at: Date | null }>(
    'SELECT read_at FROM notifications WHERE id = $1',
    [id],
  );
  return result.rows[0]?.read_at ?? null;
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

async function isWaitingForLockBesidesHolder(
  pool: Pool,
  holderPid: number,
): Promise<boolean> {
  const result = await pool.query<{ pid: number | string }>(
    `SELECT pid
     FROM pg_stat_activity
     WHERE wait_event_type = 'Lock'
       AND pid <> $1
       AND pid <> pg_backend_pid()`,
    [holderPid],
  );
  return result.rows.length > 0;
}

void describe('Notification read-all PostgreSQL concurrency', () => {
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
    'uses one database readThrough, createdAt cutoff, and visibility-first update',
    { skip: skipWithoutDatabase, timeout: 90_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const notifications = createNotificationRepository(database.pool);
      const maintenance = createMaintenanceRepository(database.pool);
      const readAll = createReadAllNotificationsFromPool(database.pool);
      const alex = createUuidV7();
      const jamie = createUuidV7();
      const homeA = createUuidV7();
      const homeB = createUuidV7();
      const archived = createUuidV7();
      const alexA = createUuidV7();
      const alexEnded = createUuidV7();
      const jamieA = createUuidV7();
      const jamieB = createUuidV7();
      const archivedMembership = createUuidV7();
      const privateB = createUuidV7();
      const alreadyReadAt = new Date('2026-09-01T00:00:00.000Z');
      const futureCreated = new Date('2099-01-01T00:00:00.000Z');
      const pastOccurred = new Date('2020-01-01T00:00:00.000Z');
      try {
        await insertUser(database.pool, alex);
        await insertUser(database.pool, jamie);
        await insertHome(database.pool, { id: homeA, name: 'Home A' });
        await insertHome(database.pool, { id: homeB, name: 'Home B' });
        await insertHome(database.pool, {
          id: archived,
          name: 'Archived',
          archived: true,
        });
        await insertMembership(database.pool, {
          id: alexA,
          homeId: homeA,
          userId: alex,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: alexEnded,
          homeId: homeA,
          userId: alex,
          role: 'ROOMMATE',
          ended: true,
        });
        await insertMembership(database.pool, {
          id: jamieA,
          homeId: homeA,
          userId: jamie,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: jamieB,
          homeId: homeB,
          userId: jamie,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: archivedMembership,
          homeId: archived,
          userId: alex,
          role: 'ROOMMATE',
        });
        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await maintenance.insertEntryWithAudience(tx, {
            entry: {
              id: privateB,
              homeId: homeA,
              createdByMembershipId: jamieA,
              visibility: 'PRIVATE',
              title: 'Private B leak title',
              details: 'PRIVATE_B_DETAILS',
              status: 'OPEN',
              resolvedByMembershipId: null,
              resolvedAt: null,
              createdAt: CREATED,
              updatedAt: CREATED,
            },
            audienceMembershipIds: [jamieA],
          });
        });

        const eligible = row(homeA, alexA, { createdAt: CREATED });
        const eligibleSecond = row(homeA, alexA, { createdAt: CREATED });
        const already = row(homeA, alexA, { readAt: alreadyReadAt });
        const future = row(homeA, alexA, {
          occurredAt: pastOccurred,
          createdAt: futureCreated,
        });
        const otherUser = row(homeA, jamieA);
        const crossHome = row(homeB, jamieB);
        const endedTenure = row(homeA, alexEnded);
        const archivedRow = row(archived, archivedMembership);
        const hiddenPrivate = row(homeA, alexA, {
          kind: 'PRIVATE_MAINTENANCE_CREATED',
          sourceEntityId: privateB,
        });
        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await notifications.insertNotifications(tx, [
            eligible,
            eligibleSecond,
            already,
            future,
            otherUser,
            crossHome,
            endedTenure,
            archivedRow,
            hiddenPrivate,
          ]);
        });

        await readAll({ userId: alex });

        const eligibleReadAt = await readAt(database.pool, eligible.id);
        const eligibleSecondReadAt = await readAt(
          database.pool,
          eligibleSecond.id,
        );
        assert.ok(eligibleReadAt instanceof Date);
        assert.ok(eligibleSecondReadAt instanceof Date);
        assert.equal(eligibleReadAt.getTime(), eligibleSecondReadAt.getTime());
        const alreadyStored = await readAt(database.pool, already.id);
        assert.equal(alreadyStored?.getTime(), alreadyReadAt.getTime());
        assert.equal(await readAt(database.pool, future.id), null);
        assert.equal(await readAt(database.pool, otherUser.id), null);
        assert.equal(await readAt(database.pool, crossHome.id), null);
        assert.equal(await readAt(database.pool, endedTenure.id), null);
        assert.equal(await readAt(database.pool, archivedRow.id), null);
        assert.equal(await readAt(database.pool, hiddenPrivate.id), null);

        const beforeSnapshot = row(homeA, alexA, {
          createdAt: new Date('2026-09-12T00:00:00.000Z'),
          occurredAt: new Date('2099-01-01T00:00:00.000Z'),
        });
        await runInReadCommittedTransaction(database.pool, (tx) =>
          notifications.insertNotification(tx, beforeSnapshot),
        );
        await readAll({ userId: alex });
        const beforeReadAt = await readAt(database.pool, beforeSnapshot.id);
        assert.ok(beforeReadAt instanceof Date);
        assert.equal(
          beforeReadAt.getTime(),
          (await readAt(database.pool, beforeSnapshot.id))?.getTime(),
        );

        await readAll({ userId: createUuidV7() });
      } finally {
        await database.pool.query(
          'DELETE FROM maintenance_audiences WHERE home_id = ANY($1::uuid[])',
          [[homeA, homeB, archived]],
        );
        await database.pool.query(
          'DELETE FROM maintenance_entries WHERE home_id = ANY($1::uuid[])',
          [[homeA, homeB, archived]],
        );
        await cleanup(database.pool, {
          userIds: [alex, jamie],
          homeIds: [homeA, homeB, archived],
        });
        await database.close();
      }
    },
  );

  void it(
    'keeps uncommitted and post-readThrough inserts unread',
    { skip: skipWithoutDatabase, timeout: 90_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const notifications = createNotificationRepository(database.pool);
      const readAll = createReadAllNotificationsFromPool(database.pool);
      const alex = createUuidV7();
      const homeA = createUuidV7();
      const alexA = createUuidV7();
      let holder: PoolClient | undefined;
      try {
        await insertUser(database.pool, alex);
        await insertHome(database.pool, { id: homeA, name: 'Home A' });
        await insertMembership(database.pool, {
          id: alexA,
          homeId: homeA,
          userId: alex,
          role: 'ROOMMATE',
        });
        const committed = row(homeA, alexA);
        await runInReadCommittedTransaction(database.pool, (tx) =>
          notifications.insertNotification(tx, committed),
        );

        const held = row(homeA, alexA, {
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        });
        holder = await database.pool.connect();
        await holder.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        const holderPidResult = await holder.query<{ pid: number | string }>(
          'SELECT pg_backend_pid() AS pid',
        );
        const holderPid = Number(holderPidResult.rows[0]?.pid);
        await holder.query(LOCK_HOME_FOR_UPDATE_SQL, [homeA]);
        await holder.query(LOCK_EXACT_MEMBERSHIP_FOR_UPDATE_SQL, [alexA]);
        await holder.query(
          `INSERT INTO notifications (
             id, home_id, recipient_membership_id, source_outbox_event_id,
             kind, source_entity_type, source_entity_id, actor_membership_id,
             occurred_at, created_at, read_at
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::uuid, NULL,
             $8::timestamptz, $9::timestamptz, NULL
           )`,
          [
            held.id,
            held.homeId,
            held.recipientMembershipId,
            held.sourceOutboxEventId,
            held.kind,
            held.sourceEntityType,
            held.sourceEntityId,
            held.occurredAt,
            held.createdAt,
          ],
        );

        const readAllPromise = readAll({ userId: alex });
        await waitUntil(() =>
          isWaitingForLockBesidesHolder(database.pool, holderPid),
        );
        await holder.query('COMMIT');
        holder.release();
        holder = undefined;
        await readAllPromise;
        assert.ok(await readAt(database.pool, committed.id));
        assert.equal(await readAt(database.pool, held.id), null);

        const after = row(homeA, alexA);
        await runInReadCommittedTransaction(database.pool, (tx) =>
          notifications.insertNotification(tx, after),
        );
        assert.equal(await readAt(database.pool, after.id), null);
      } finally {
        if (holder !== undefined) {
          try {
            await holder.query('ROLLBACK');
          } catch {
            // already closed
          }
          holder.release();
        }
        await cleanup(database.pool, {
          userIds: [alex],
          homeIds: [homeA],
        });
        await database.close();
      }
    },
  );

  void it(
    'handles membership-end races, simultaneous read-all, and serialization retry',
    { skip: skipWithoutDatabase, timeout: 90_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const notifications = createNotificationRepository(database.pool);
      const readAll = createReadAllNotificationsFromPool(database.pool);
      const alex = createUuidV7();
      const homeA = createUuidV7();
      const alexA = createUuidV7();
      try {
        await insertUser(database.pool, alex);
        await insertHome(database.pool, { id: homeA, name: 'Home A' });
        await insertMembership(database.pool, {
          id: alexA,
          homeId: homeA,
          userId: alex,
          role: 'ROOMMATE',
        });

        const readAllWins = row(homeA, alexA);
        await runInReadCommittedTransaction(database.pool, (tx) =>
          notifications.insertNotification(tx, readAllWins),
        );
        await readAll({ userId: alex });
        const marked = await readAt(database.pool, readAllWins.id);
        assert.ok(marked instanceof Date);
        await runInReadCommittedTransaction(database.pool, (tx) =>
          notifications.deleteByRecipientMembership(tx, {
            homeId: homeA,
            recipientMembershipId: alexA,
          }),
        );
        assert.equal(await readAt(database.pool, readAllWins.id), null);

        const endWins = row(homeA, alexA);
        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await notifications.insertNotification(tx, endWins);
          await notifications.deleteByRecipientMembership(tx, {
            homeId: homeA,
            recipientMembershipId: alexA,
          });
          await tx.query(
            `UPDATE memberships
             SET ended_at = NOW(), ended_by_membership_id = $2
             WHERE id = $1`,
            [alexA, alexA],
          );
        });
        await readAll({ userId: alex });
        const leftover = await database.pool.query(
          'SELECT id FROM notifications WHERE id = $1',
          [endWins.id],
        );
        assert.equal(leftover.rows.length, 0);

        await database.pool.query(
          `UPDATE memberships
           SET ended_at = NULL, ended_by_membership_id = NULL
           WHERE id = $1`,
          [alexA],
        );

        const concurrentA = row(homeA, alexA);
        const concurrentB = row(homeA, alexA);
        await runInReadCommittedTransaction(database.pool, (tx) =>
          notifications.insertNotifications(tx, [concurrentA, concurrentB]),
        );
        await Promise.all([
          readAll({ userId: alex }),
          readAll({ userId: alex }),
        ]);
        const firstReadAt = await readAt(database.pool, concurrentA.id);
        const secondReadAt = await readAt(database.pool, concurrentB.id);
        assert.ok(firstReadAt instanceof Date);
        assert.ok(secondReadAt instanceof Date);
        assert.equal(firstReadAt.getTime(), secondReadAt.getTime());
        await Promise.all([
          readAll({ userId: alex }),
          readAll({ userId: alex }),
        ]);
        assert.equal(
          (await readAt(database.pool, concurrentA.id))?.getTime(),
          firstReadAt.getTime(),
        );
        assert.equal(
          (await readAt(database.pool, concurrentB.id))?.getTime(),
          secondReadAt.getTime(),
        );

        const stale = row(homeA, alexA);
        await runInReadCommittedTransaction(database.pool, (tx) =>
          notifications.insertNotification(tx, stale),
        );
        const blocker = await database.pool.connect();
        const racing = await database.pool.connect();
        try {
          await blocker.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await blocker.query('SELECT transaction_timestamp()');
          await blocker.query(
            `SELECT memberships.id
             FROM memberships
             INNER JOIN homes ON homes.id = memberships.home_id
             WHERE memberships.user_id = $1
               AND memberships.ended_at IS NULL
               AND homes.archived_at IS NULL`,
            [alex],
          );
          await racing.query('BEGIN ISOLATION LEVEL READ COMMITTED');
          await racing.query(
            `UPDATE memberships
             SET ended_at = NOW(), ended_by_membership_id = $2
             WHERE id = $1`,
            [alexA, alexA],
          );
          await racing.query('COMMIT');
          await assert.rejects(async () => {
            await blocker.query(
              `SELECT id FROM homes WHERE id = $1 FOR UPDATE`,
              [homeA],
            );
            await blocker.query(
              `SELECT id FROM memberships WHERE id = $1 FOR UPDATE`,
              [alexA],
            );
            await blocker.query('COMMIT');
          });
        } finally {
          try {
            await blocker.query('ROLLBACK');
          } catch {
            // already closed
          }
          blocker.release();
          racing.release();
        }
        await readAll({ userId: alex });
        assert.equal(await readAt(database.pool, stale.id), null);
      } finally {
        await cleanup(database.pool, {
          userIds: [alex],
          homeIds: [homeA],
        });
        await database.close();
      }
    },
  );
});
