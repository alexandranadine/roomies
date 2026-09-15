import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createActivityRepository } from '../../domains/activity/repository.js';
import { createMaintenanceRepository } from '../../domains/maintenance/repository.js';
import { createNotificationRepository } from '../../domains/notifications/repository.js';
import type { NewNotification } from '../../domains/notifications/repository.js';
import type { AppConfig } from '../../platform/config/types.js';
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
import {
  createOutboxConsumerFromPool,
  createOutboxHandlerRegistry,
} from '../../platform/outbox/index.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import { createActivityOutboxHandlerFromPool } from '../activity/outbox-handler.js';
import { createCreateMaintenanceEntryFromPool } from './create-maintenance-entry.js';
import { createNotificationOutboxHandlerFromPool } from '../notifications/outbox-handler.js';
import { createEraseAuthoredMaintenanceFromPool } from './erase-authored-maintenance.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const CREATED = new Date('2026-09-14T12:00:00.000Z');
const RESOLVED = new Date('2026-09-14T13:00:00.000Z');

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

async function insertHome(pool: Pool, id: string, name: string): Promise<void> {
  await pool.query(
    `INSERT INTO homes (id, name, timezone, archived_at, updated_at)
     VALUES ($1, $2, 'UTC', NULL, NOW())`,
    [id, name],
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

async function cleanup(
  pool: Pool,
  input: { homeIds: string[]; userIds: string[] },
): Promise<void> {
  if (input.homeIds.length > 0) {
    await pool.query(
      'DELETE FROM notifications WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query(
      'DELETE FROM activity_recipients WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query('DELETE FROM activities WHERE home_id = ANY($1::uuid[])', [
      input.homeIds,
    ]);
    await pool.query(
      'DELETE FROM maintenance_audiences WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query(
      'DELETE FROM maintenance_entries WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query(
      'DELETE FROM outbox_events WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query(
      'DELETE FROM membership_role_transitions WHERE home_id = ANY($1::uuid[])',
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
    const remainingMemberships = await pool.query<{ id: string }>(
      'SELECT id FROM memberships WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
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
    await pool.query('DELETE FROM homes WHERE id = ANY($1::uuid[])', [
      input.homeIds,
    ]);
  }
  if (input.userIds.length > 0) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [input.userIds]);
  }
}

type Household = {
  userAlex: string;
  userJamie: string;
  userTaylor: string;
  homeId: string;
  alexCurrent: string;
  alexEnded: string;
  jamie: string;
  taylor: string;
};

async function seedHousehold(pool: Pool, name: string): Promise<Household> {
  const household: Household = {
    userAlex: randomUUID(),
    userJamie: randomUUID(),
    userTaylor: randomUUID(),
    homeId: createUuidV7(),
    alexCurrent: createUuidV7(),
    alexEnded: createUuidV7(),
    jamie: createUuidV7(),
    taylor: createUuidV7(),
  };
  await insertUser(pool, household.userAlex);
  await insertUser(pool, household.userJamie);
  await insertUser(pool, household.userTaylor);
  await insertHome(pool, household.homeId, name);
  await insertMembership(pool, {
    id: household.alexEnded,
    homeId: household.homeId,
    userId: household.userAlex,
    role: 'ROOMMATE',
    ended: true,
  });
  await insertMembership(pool, {
    id: household.alexCurrent,
    homeId: household.homeId,
    userId: household.userAlex,
    role: 'ROOMMATE',
  });
  await insertMembership(pool, {
    id: household.jamie,
    homeId: household.homeId,
    userId: household.userJamie,
    role: 'ROOMMATE',
  });
  await insertMembership(pool, {
    id: household.taylor,
    homeId: household.homeId,
    userId: household.userTaylor,
    role: 'ADMIN',
  });
  return household;
}

async function insertEntry(
  pool: Pool,
  input: {
    id: string;
    homeId: string;
    createdByMembershipId: string;
    visibility: 'HOUSEHOLD' | 'PRIVATE';
    title: string;
    audienceMembershipIds?: readonly string[];
    resolvedByMembershipId?: string;
  },
): Promise<void> {
  const maintenance = createMaintenanceRepository(pool);
  const resolved = input.resolvedByMembershipId !== undefined;
  await runInReadCommittedTransaction(pool, async (tx) => {
    await maintenance.insertEntryWithAudience(tx, {
      entry: {
        id: input.id,
        homeId: input.homeId,
        createdByMembershipId: input.createdByMembershipId,
        visibility: input.visibility,
        title: input.title,
        details: null,
        status: resolved ? 'RESOLVED' : 'OPEN',
        resolvedByMembershipId: input.resolvedByMembershipId ?? null,
        resolvedAt: resolved ? RESOLVED : null,
        createdAt: CREATED,
        updatedAt: resolved ? RESOLVED : CREATED,
      },
      audienceMembershipIds: input.audienceMembershipIds ?? [],
    });
  });
}

async function insertMaintenanceActivity(
  pool: Pool,
  input: {
    homeId: string;
    sourceEntityId: string;
    visibility: 'HOUSEHOLD' | 'PRIVATE';
    recipientMembershipIds?: readonly string[];
    actorMembershipId: string;
    eventType?: string;
  },
): Promise<string> {
  const activity = createActivityRepository(pool);
  const id = createUuidV7();
  await runInReadCommittedTransaction(pool, async (tx) => {
    const row = {
      id,
      homeId: input.homeId,
      sourceOutboxEventId: createUuidV7(),
      sourceEntityType: 'MAINTENANCE' as const,
      sourceEntityId: input.sourceEntityId,
      eventType: input.eventType ?? 'maintenance.created.v1',
      actorMembershipId: input.actorMembershipId,
      occurredAt: CREATED,
      createdAt: CREATED,
    };
    if (input.visibility === 'HOUSEHOLD') {
      await activity.insertHomeVisibleActivity(tx, row);
      return;
    }
    await activity.insertSourceAuthorizedActivity(
      tx,
      row,
      input.recipientMembershipIds ?? [],
    );
  });
  return id;
}

async function insertTypedActivity(
  pool: Pool,
  input: {
    homeId: string;
    sourceEntityType: 'TASK' | 'SUPPLY' | 'MEMBERSHIP';
    sourceEntityId: string;
    actorMembershipId: string;
    eventType: string;
  },
): Promise<string> {
  const activity = createActivityRepository(pool);
  const id = createUuidV7();
  await runInReadCommittedTransaction(pool, async (tx) => {
    await activity.insertHomeVisibleActivity(tx, {
      id,
      homeId: input.homeId,
      sourceOutboxEventId: createUuidV7(),
      sourceEntityType: input.sourceEntityType,
      sourceEntityId: input.sourceEntityId,
      eventType: input.eventType,
      actorMembershipId: input.actorMembershipId,
      occurredAt: CREATED,
      createdAt: CREATED,
    });
  });
  return id;
}

async function insertNotificationRow(
  pool: Pool,
  input: NewNotification,
): Promise<void> {
  const notifications = createNotificationRepository(pool);
  await runInReadCommittedTransaction(pool, async (tx) => {
    await notifications.insertNotification(tx, input);
  });
}

function maintenanceNotification(input: {
  homeId: string;
  recipientMembershipId: string;
  sourceEntityId: string;
  actorMembershipId: string;
  kind?: 'PRIVATE_MAINTENANCE_CREATED' | 'PRIVATE_MAINTENANCE_RESOLVED';
}): NewNotification {
  const kind = input.kind ?? 'PRIVATE_MAINTENANCE_CREATED';
  return Object.freeze({
    id: createUuidV7(),
    homeId: input.homeId,
    recipientMembershipId: input.recipientMembershipId,
    sourceOutboxEventId: createUuidV7(),
    kind,
    sourceEntityType: 'MAINTENANCE',
    sourceEntityId: input.sourceEntityId,
    actorMembershipId: input.actorMembershipId,
    occurredAt: CREATED,
    createdAt: CREATED,
    readAt: null,
  });
}

async function eraseAuthored(
  pool: Pool,
  membershipIds: readonly string[],
): Promise<void> {
  const erase = createEraseAuthoredMaintenanceFromPool(pool);
  await runInReadCommittedTransaction(pool, async (tx) => {
    await erase(tx, { membershipIds });
  });
}

async function entryIds(
  pool: Pool,
  homeId: string,
): Promise<readonly string[]> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM maintenance_entries WHERE home_id = $1 ORDER BY id ASC`,
    [homeId],
  );
  return result.rows.map((row) => row.id);
}

async function audienceMembershipIds(
  pool: Pool,
  maintenanceEntryId: string,
): Promise<readonly string[]> {
  const result = await pool.query<{ membership_id: string }>(
    `SELECT membership_id
     FROM maintenance_audiences
     WHERE maintenance_entry_id = $1
     ORDER BY membership_id ASC`,
    [maintenanceEntryId],
  );
  return result.rows.map((row) => row.membership_id);
}

async function activitySourceIds(
  pool: Pool,
  homeId: string,
): Promise<readonly string[]> {
  const result = await pool.query<{ source_entity_id: string }>(
    `SELECT source_entity_id
     FROM activities
     WHERE home_id = $1
     ORDER BY source_entity_type ASC, source_entity_id ASC, id ASC`,
    [homeId],
  );
  return result.rows.map((row) => row.source_entity_id);
}

async function activityCountForSource(
  pool: Pool,
  homeId: string,
  sourceEntityId: string,
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM activities
     WHERE home_id = $1
       AND source_entity_type = 'MAINTENANCE'
       AND source_entity_id = $2`,
    [homeId, sourceEntityId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function recipientCountForSource(
  pool: Pool,
  homeId: string,
  sourceEntityId: string,
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM activity_recipients r
     INNER JOIN activities a
       ON a.id = r.activity_id
      AND a.home_id = r.home_id
     WHERE a.home_id = $1
       AND a.source_entity_type = 'MAINTENANCE'
       AND a.source_entity_id = $2`,
    [homeId, sourceEntityId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function notificationCountForSource(
  pool: Pool,
  homeId: string,
  sourceEntityId: string,
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM notifications
     WHERE home_id = $1
       AND source_entity_type = 'MAINTENANCE'
       AND source_entity_id = $2`,
    [homeId, sourceEntityId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function visibleIds(
  pool: Pool,
  homeId: string,
  actorMembershipId: string,
): Promise<readonly string[]> {
  const page = await createMaintenanceRepository(pool).listVisibleByHome({
    homeId,
    actorMembershipId,
    limit: 50,
  });
  return (page?.items ?? []).map((item) => item.id).sort();
}

async function drainCombined(pool: Pool): Promise<void> {
  const consumer = createOutboxConsumerFromPool(pool, {
    registry: createOutboxHandlerRegistry([
      createActivityOutboxHandlerFromPool(pool),
      createNotificationOutboxHandlerFromPool(pool),
    ]),
    logger: {
      info() {},
      error() {},
    },
  });
  for (;;) {
    const result = await consumer.drain({ batchSize: 20 });
    if (!result.moreWorkLikely) {
      return;
    }
  }
}

void describe('Maintenance authored-source erasure PostgreSQL', () => {
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
    'erases only Alex-authored sources and their derived projections',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const homeA = await seedHousehold(database.pool, 'Erasure home A');
      const homeB = await seedHousehold(database.pool, 'Erasure home B');
      const h1 = createUuidV7();
      const a1 = createUuidV7();
      const a2 = createUuidV7();
      const r1 = createUuidV7();
      const j1 = createUuidV7();
      const j2 = createUuidV7();
      const t1 = createUuidV7();
      const jOther = createUuidV7();
      const h1b = createUuidV7();
      const a1b = createUuidV7();
      const taskSource = createUuidV7();
      const supplySource = createUuidV7();
      const membershipSource = homeA.jamie;
      const taskNotificationId = createUuidV7();
      const j1NotificationId = createUuidV7();
      const userIds = [
        homeA.userAlex,
        homeA.userJamie,
        homeA.userTaylor,
        homeB.userAlex,
        homeB.userJamie,
        homeB.userTaylor,
      ];
      const homeIds = [homeA.homeId, homeB.homeId];

      try {
        await insertEntry(database.pool, {
          id: h1,
          homeId: homeA.homeId,
          createdByMembershipId: homeA.alexCurrent,
          visibility: 'HOUSEHOLD',
          title: 'H1 household',
        });
        await insertEntry(database.pool, {
          id: a1,
          homeId: homeA.homeId,
          createdByMembershipId: homeA.alexCurrent,
          visibility: 'PRIVATE',
          title: 'A1 private',
          audienceMembershipIds: [homeA.alexCurrent, homeA.jamie],
        });
        await insertEntry(database.pool, {
          id: a2,
          homeId: homeA.homeId,
          createdByMembershipId: homeA.alexEnded,
          visibility: 'PRIVATE',
          title: 'A2 ended tenure',
          audienceMembershipIds: [homeA.alexEnded, homeA.jamie],
        });
        await insertEntry(database.pool, {
          id: r1,
          homeId: homeA.homeId,
          createdByMembershipId: homeA.alexCurrent,
          visibility: 'PRIVATE',
          title: 'R1 authored resolved',
          audienceMembershipIds: [homeA.alexCurrent, homeA.jamie],
          resolvedByMembershipId: homeA.jamie,
        });
        await insertEntry(database.pool, {
          id: j1,
          homeId: homeA.homeId,
          createdByMembershipId: homeA.jamie,
          visibility: 'PRIVATE',
          title: 'J1 private',
          audienceMembershipIds: [homeA.jamie, homeA.alexCurrent],
        });
        await insertEntry(database.pool, {
          id: j2,
          homeId: homeA.homeId,
          createdByMembershipId: homeA.jamie,
          visibility: 'PRIVATE',
          title: 'J2 jamie only',
          audienceMembershipIds: [homeA.jamie],
          resolvedByMembershipId: homeA.alexCurrent,
        });
        await insertEntry(database.pool, {
          id: t1,
          homeId: homeA.homeId,
          createdByMembershipId: homeA.taylor,
          visibility: 'HOUSEHOLD',
          title: 'T1 household',
          resolvedByMembershipId: homeA.alexCurrent,
        });
        await insertEntry(database.pool, {
          id: jOther,
          homeId: homeA.homeId,
          createdByMembershipId: homeA.jamie,
          visibility: 'PRIVATE',
          title: 'J other source Y',
          audienceMembershipIds: [homeA.jamie],
        });
        await insertEntry(database.pool, {
          id: h1b,
          homeId: homeB.homeId,
          createdByMembershipId: homeB.alexCurrent,
          visibility: 'HOUSEHOLD',
          title: 'Home B household',
        });
        await insertEntry(database.pool, {
          id: a1b,
          homeId: homeB.homeId,
          createdByMembershipId: homeB.alexCurrent,
          visibility: 'PRIVATE',
          title: 'Home B private',
          audienceMembershipIds: [homeB.alexCurrent, homeB.jamie],
        });

        await insertMaintenanceActivity(database.pool, {
          homeId: homeA.homeId,
          sourceEntityId: h1,
          visibility: 'HOUSEHOLD',
          actorMembershipId: homeA.alexCurrent,
        });
        await insertMaintenanceActivity(database.pool, {
          homeId: homeA.homeId,
          sourceEntityId: a1,
          visibility: 'PRIVATE',
          recipientMembershipIds: [homeA.alexCurrent, homeA.jamie],
          actorMembershipId: homeA.alexCurrent,
        });
        await insertMaintenanceActivity(database.pool, {
          homeId: homeA.homeId,
          sourceEntityId: a2,
          visibility: 'PRIVATE',
          recipientMembershipIds: [homeA.alexEnded, homeA.jamie],
          actorMembershipId: homeA.alexEnded,
        });
        await insertMaintenanceActivity(database.pool, {
          homeId: homeA.homeId,
          sourceEntityId: r1,
          visibility: 'PRIVATE',
          recipientMembershipIds: [homeA.alexCurrent, homeA.jamie],
          actorMembershipId: homeA.jamie,
          eventType: 'maintenance.resolved.v1',
        });
        await insertMaintenanceActivity(database.pool, {
          homeId: homeA.homeId,
          sourceEntityId: j1,
          visibility: 'PRIVATE',
          recipientMembershipIds: [homeA.jamie, homeA.alexCurrent],
          actorMembershipId: homeA.jamie,
        });
        await insertMaintenanceActivity(database.pool, {
          homeId: homeA.homeId,
          sourceEntityId: j2,
          visibility: 'PRIVATE',
          recipientMembershipIds: [homeA.jamie],
          actorMembershipId: homeA.jamie,
        });
        await insertMaintenanceActivity(database.pool, {
          homeId: homeA.homeId,
          sourceEntityId: t1,
          visibility: 'HOUSEHOLD',
          actorMembershipId: homeA.taylor,
        });
        await insertMaintenanceActivity(database.pool, {
          homeId: homeA.homeId,
          sourceEntityId: jOther,
          visibility: 'PRIVATE',
          recipientMembershipIds: [homeA.jamie],
          actorMembershipId: homeA.jamie,
        });
        await insertMaintenanceActivity(database.pool, {
          homeId: homeB.homeId,
          sourceEntityId: h1b,
          visibility: 'HOUSEHOLD',
          actorMembershipId: homeB.alexCurrent,
        });
        await insertMaintenanceActivity(database.pool, {
          homeId: homeB.homeId,
          sourceEntityId: a1b,
          visibility: 'PRIVATE',
          recipientMembershipIds: [homeB.alexCurrent, homeB.jamie],
          actorMembershipId: homeB.alexCurrent,
        });
        await insertTypedActivity(database.pool, {
          homeId: homeA.homeId,
          sourceEntityType: 'TASK',
          sourceEntityId: taskSource,
          actorMembershipId: homeA.jamie,
          eventType: 'task.completed.v1',
        });
        await insertTypedActivity(database.pool, {
          homeId: homeA.homeId,
          sourceEntityType: 'SUPPLY',
          sourceEntityId: supplySource,
          actorMembershipId: homeA.jamie,
          eventType: 'supply.obtained.v1',
        });
        await insertTypedActivity(database.pool, {
          homeId: homeA.homeId,
          sourceEntityType: 'MEMBERSHIP',
          sourceEntityId: membershipSource,
          actorMembershipId: homeA.jamie,
          eventType: 'membership.started.v1',
        });

        await insertNotificationRow(
          database.pool,
          maintenanceNotification({
            homeId: homeA.homeId,
            recipientMembershipId: homeA.jamie,
            sourceEntityId: a1,
            actorMembershipId: homeA.alexCurrent,
          }),
        );
        await insertNotificationRow(
          database.pool,
          maintenanceNotification({
            homeId: homeA.homeId,
            recipientMembershipId: homeA.jamie,
            sourceEntityId: a2,
            actorMembershipId: homeA.alexEnded,
          }),
        );
        await insertNotificationRow(
          database.pool,
          maintenanceNotification({
            homeId: homeA.homeId,
            recipientMembershipId: homeA.alexCurrent,
            sourceEntityId: r1,
            actorMembershipId: homeA.jamie,
            kind: 'PRIVATE_MAINTENANCE_RESOLVED',
          }),
        );
        await insertNotificationRow(database.pool, {
          ...maintenanceNotification({
            homeId: homeA.homeId,
            recipientMembershipId: homeA.alexCurrent,
            sourceEntityId: j1,
            actorMembershipId: homeA.jamie,
          }),
          id: j1NotificationId,
        });
        await insertNotificationRow(
          database.pool,
          maintenanceNotification({
            homeId: homeA.homeId,
            recipientMembershipId: homeA.jamie,
            sourceEntityId: jOther,
            actorMembershipId: homeA.jamie,
          }),
        );
        await insertNotificationRow(
          database.pool,
          maintenanceNotification({
            homeId: homeB.homeId,
            recipientMembershipId: homeB.jamie,
            sourceEntityId: a1b,
            actorMembershipId: homeB.alexCurrent,
          }),
        );
        await insertNotificationRow(database.pool, {
          id: taskNotificationId,
          homeId: homeA.homeId,
          recipientMembershipId: homeA.alexCurrent,
          sourceOutboxEventId: createUuidV7(),
          kind: 'ASSIGNED_TASK_COMPLETED',
          sourceEntityType: 'TASK',
          sourceEntityId: taskSource,
          actorMembershipId: homeA.jamie,
          occurredAt: CREATED,
          createdAt: CREATED,
          readAt: null,
        });

        const authoredResolved = await database.pool.query<{
          status: string;
          resolved_by_membership_id: string | null;
          resolved_at: Date | null;
        }>(
          `SELECT status, resolved_by_membership_id, resolved_at
           FROM maintenance_entries
           WHERE id = $1`,
          [r1],
        );
        assert.equal(authoredResolved.rows[0]?.status, 'RESOLVED');
        assert.equal(
          authoredResolved.rows[0]?.resolved_by_membership_id,
          homeA.jamie,
        );
        assert.ok(authoredResolved.rows[0]?.resolved_at instanceof Date);

        await eraseAuthored(database.pool, [
          homeA.alexCurrent,
          homeA.alexEnded,
        ]);

        const remaining = await entryIds(database.pool, homeA.homeId);
        assert.deepEqual([...remaining].sort(), [j1, j2, jOther, t1].sort());
        assert.equal(remaining.includes(h1), false);
        assert.equal(remaining.includes(a1), false);
        assert.equal(remaining.includes(a2), false);
        assert.equal(remaining.includes(r1), false);

        assert.deepEqual(await audienceMembershipIds(database.pool, a1), []);
        assert.deepEqual(await audienceMembershipIds(database.pool, a2), []);
        assert.deepEqual(await audienceMembershipIds(database.pool, r1), []);
        assert.deepEqual(
          await audienceMembershipIds(database.pool, j1),
          [homeA.alexCurrent, homeA.jamie].sort(),
        );
        assert.deepEqual(await audienceMembershipIds(database.pool, j2), [
          homeA.jamie,
        ]);

        assert.equal(
          await activityCountForSource(database.pool, homeA.homeId, h1),
          0,
        );
        assert.equal(
          await activityCountForSource(database.pool, homeA.homeId, a1),
          0,
        );
        assert.equal(
          await activityCountForSource(database.pool, homeA.homeId, a2),
          0,
        );
        assert.equal(
          await activityCountForSource(database.pool, homeA.homeId, r1),
          0,
        );
        assert.equal(
          await recipientCountForSource(database.pool, homeA.homeId, h1),
          0,
        );
        assert.equal(
          await recipientCountForSource(database.pool, homeA.homeId, a1),
          0,
        );
        assert.equal(
          await recipientCountForSource(database.pool, homeA.homeId, a2),
          0,
        );
        assert.equal(
          await recipientCountForSource(database.pool, homeA.homeId, r1),
          0,
        );
        assert.equal(
          await notificationCountForSource(database.pool, homeA.homeId, h1),
          0,
        );
        assert.equal(
          await notificationCountForSource(database.pool, homeA.homeId, a1),
          0,
        );
        assert.equal(
          await notificationCountForSource(database.pool, homeA.homeId, a2),
          0,
        );
        assert.equal(
          await notificationCountForSource(database.pool, homeA.homeId, r1),
          0,
        );

        assert.ok(
          (await activityCountForSource(database.pool, homeA.homeId, j1)) >= 1,
        );
        assert.ok(
          (await activityCountForSource(database.pool, homeA.homeId, j2)) >= 1,
        );
        assert.ok(
          (await activityCountForSource(database.pool, homeA.homeId, t1)) >= 1,
        );
        assert.equal(
          await notificationCountForSource(database.pool, homeA.homeId, j1),
          1,
        );

        const retained = await database.pool.query<{
          id: string;
          visibility: string;
          resolved_by_membership_id: string | null;
        }>(
          `SELECT id, visibility, resolved_by_membership_id
           FROM maintenance_entries
           WHERE id = ANY($1::uuid[])
           ORDER BY id ASC`,
          [[j1, j2, t1]],
        );
        const byId = new Map(retained.rows.map((row) => [row.id, row]));
        assert.equal(byId.get(j1)?.visibility, 'PRIVATE');
        assert.equal(byId.get(j2)?.visibility, 'PRIVATE');
        assert.equal(byId.get(t1)?.visibility, 'HOUSEHOLD');
        assert.equal(
          byId.get(j2)?.resolved_by_membership_id,
          homeA.alexCurrent,
        );
        assert.equal(
          byId.get(t1)?.resolved_by_membership_id,
          homeA.alexCurrent,
        );

        const jamieVisible = await visibleIds(
          database.pool,
          homeA.homeId,
          homeA.jamie,
        );
        assert.deepEqual(jamieVisible, [j1, j2, jOther, t1].sort());
        const taylorVisible = await visibleIds(
          database.pool,
          homeA.homeId,
          homeA.taylor,
        );
        assert.deepEqual(taylorVisible, [t1]);
        const alexVisible = await visibleIds(
          database.pool,
          homeA.homeId,
          homeA.alexCurrent,
        );
        assert.deepEqual(alexVisible, [j1, t1].sort());

        const maintenance = createMaintenanceRepository(database.pool);
        assert.equal(
          await maintenance.findVisibleByHomeAndId(
            homeA.homeId,
            j1,
            homeA.taylor,
          ),
          null,
        );
        assert.equal(
          await maintenance.findVisibleByHomeAndId(
            homeA.homeId,
            j2,
            homeA.taylor,
          ),
          null,
        );

        assert.deepEqual(
          [...(await entryIds(database.pool, homeB.homeId))].sort(),
          [a1b, h1b].sort(),
        );
        assert.ok(
          (await activityCountForSource(database.pool, homeB.homeId, h1b)) >= 1,
        );
        assert.ok(
          (await activityCountForSource(database.pool, homeB.homeId, a1b)) >= 1,
        );
        assert.equal(
          await notificationCountForSource(database.pool, homeB.homeId, a1b),
          1,
        );

        const leftoverSources = await activitySourceIds(
          database.pool,
          homeA.homeId,
        );
        assert.ok(leftoverSources.includes(j1));
        assert.ok(leftoverSources.includes(jOther));
        assert.ok(leftoverSources.includes(taskSource));
        assert.ok(leftoverSources.includes(supplySource));
        assert.ok(leftoverSources.includes(membershipSource));

        const keptNotifications = await database.pool.query<{ id: string }>(
          `SELECT id FROM notifications WHERE id = ANY($1::uuid[])`,
          [[j1NotificationId, taskNotificationId]],
        );
        assert.equal(keptNotifications.rows.length, 2);

        await eraseAuthored(database.pool, []);
        assert.deepEqual(
          [...(await entryIds(database.pool, homeA.homeId))].sort(),
          [j1, j2, jOther, t1].sort(),
        );
      } finally {
        await cleanup(database.pool, { homeIds, userIds });
        await database.pool.end();
      }
    },
  );

  void it(
    'leaves a pending Maintenance outbox event and later consumers no-op',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userId = randomUUID();
      const homeId = createUuidV7();
      const membershipId = createUuidV7();
      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, homeId, 'Pending outbox home');
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ROOMMATE',
        });
        const created = await createCreateMaintenanceEntryFromPool(
          database.pool,
        )({
          actor: {
            userId,
            membershipId,
            homeId,
            role: 'ROOMMATE',
          },
          homeId,
          visibility: 'PRIVATE',
          title: 'Pending authored source',
          audienceMembershipIds: [membershipId],
        });

        const pending = await database.pool.query<{
          event_id: string;
          event_type: string;
          payload: { maintenanceEntryId?: string };
          processed_at: Date | null;
        }>(
          `SELECT event_id, event_type, payload, processed_at
           FROM outbox_events
           WHERE home_id = $1
           ORDER BY created_at ASC`,
          [homeId],
        );
        assert.equal(pending.rows.length, 1);
        assert.equal(pending.rows[0]?.processed_at, null);
        assert.equal(pending.rows[0]?.event_type, 'maintenance.created.v1');
        assert.deepEqual(pending.rows[0]?.payload, {
          maintenanceEntryId: created.id,
        });
        const serialized = JSON.stringify(pending.rows[0]?.payload);
        assert.doesNotMatch(serialized, /Pending authored source/);
        assert.doesNotMatch(serialized, /audience/);
        assert.doesNotMatch(serialized, /@/);

        await eraseAuthored(database.pool, [membershipId]);
        const afterErase = await database.pool.query<{
          event_id: string;
          payload: unknown;
          processed_at: Date | null;
        }>(
          `SELECT event_id, payload, processed_at
           FROM outbox_events
           WHERE home_id = $1`,
          [homeId],
        );
        assert.equal(afterErase.rows.length, 1);
        assert.equal(afterErase.rows[0]?.processed_at, null);
        assert.deepEqual(afterErase.rows[0]?.payload, {
          maintenanceEntryId: created.id,
        });
        assert.deepEqual(await entryIds(database.pool, homeId), []);

        await drainCombined(database.pool);
        assert.equal(
          await activityCountForSource(database.pool, homeId, created.id),
          0,
        );
        assert.equal(
          await notificationCountForSource(database.pool, homeId, created.id),
          0,
        );
        const processed = await database.pool.query<{
          processed_at: Date | null;
        }>(`SELECT processed_at FROM outbox_events WHERE home_id = $1`, [
          homeId,
        ]);
        assert.ok(processed.rows[0]?.processed_at instanceof Date);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userId],
        });
        await database.pool.end();
      }
    },
  );

  void it(
    'deletes projections when the consumer wins, then later consumers cannot recreate',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const homeId = createUuidV7();
      const author = createUuidV7();
      const audience = createUuidV7();
      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, homeId, 'Consumer wins home');
        await insertMembership(database.pool, {
          id: author,
          homeId,
          userId: userA,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: audience,
          homeId,
          userId: userB,
          role: 'ROOMMATE',
        });
        const created = await createCreateMaintenanceEntryFromPool(
          database.pool,
        )({
          actor: {
            userId: userA,
            membershipId: author,
            homeId,
            role: 'ROOMMATE',
          },
          homeId,
          visibility: 'PRIVATE',
          title: 'Consumer first',
          audienceMembershipIds: [author, audience],
        });
        await drainCombined(database.pool);
        assert.ok(
          (await activityCountForSource(database.pool, homeId, created.id)) >=
            1,
        );
        assert.ok(
          (await notificationCountForSource(
            database.pool,
            homeId,
            created.id,
          )) >= 1,
        );

        await eraseAuthored(database.pool, [author]);
        assert.equal(
          await activityCountForSource(database.pool, homeId, created.id),
          0,
        );
        assert.equal(
          await recipientCountForSource(database.pool, homeId, created.id),
          0,
        );
        assert.equal(
          await notificationCountForSource(database.pool, homeId, created.id),
          0,
        );
        assert.deepEqual(await entryIds(database.pool, homeId), []);

        await drainCombined(database.pool);
        assert.equal(
          await activityCountForSource(database.pool, homeId, created.id),
          0,
        );
        assert.equal(
          await notificationCountForSource(database.pool, homeId, created.id),
          0,
        );
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userA, userB],
        });
        await database.pool.end();
      }
    },
  );
});
