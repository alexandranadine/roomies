import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createLeaveMembershipFromPool } from '../home-administration/leave-membership.js';
import { ActivityPersistenceError } from '../../domains/activity/errors.js';
import { createActivityRepository } from '../../domains/activity/repository.js';
import {
  MAINTENANCE_CREATED_V1,
  MAINTENANCE_RESOLVED_V1,
} from '../../domains/maintenance/events.js';
import { findMaintenanceActivitySource } from '../../domains/maintenance/find-maintenance-activity-source.js';
import {
  findMembershipEndedActivitySource,
  findMembershipRoleTransitionActivitySource,
  findMembershipStartedActivitySource,
} from '../../domains/memberships/find-membership-activity-source.js';
import { SUPPLY_OBTAINED_V1 } from '../../domains/supplies/events.js';
import { findSupplyActivitySource } from '../../domains/supplies/find-supply-activity-source.js';
import { TASK_COMPLETED_V1 } from '../../domains/tasks/events.js';
import { findTaskActivitySource } from '../../domains/tasks/find-task-activity-source.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import type { AppConfig } from '../../platform/config/types.js';
import { createUuidV7, systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import {
  createOutboxConsumerFromPool,
  createOutboxHandlerRegistry,
  type OutboxConsumerLogFields,
  type OutboxEventHandler,
  type OutboxRetryPolicy,
} from '../../platform/outbox/index.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { createCreateMaintenanceEntryFromPool } from '../maintenance/create-maintenance-entry.js';
import { createClaimSupplyEntryFromPool } from '../supplies/claim-supply-entry.js';
import { createCreateSupplyEntryFromPool } from '../supplies/create-supply-entry.js';
import { createMarkSupplyEntryObtainedFromPool } from '../supplies/mark-supply-entry-obtained.js';
import { createCompleteTaskFromPool } from '../tasks/complete-task.js';
import { ActivityProjectionIntegrityError } from './errors.js';
import {
  ACTIVITY_OUTBOX_HANDLER_ID,
  createActivityOutboxHandler,
  createActivityOutboxHandlerFromPool,
} from './outbox-handler.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const TITLE_SENTINEL = 'SENTINEL_TASK_SUPPLY_TITLE_LEAK_M64A';
const ZERO_BACKOFF: OutboxRetryPolicy = Object.freeze({
  maxAttempts: 8,
  backoffMs: () => 0,
});
const CREATED = new Date('2026-09-13T17:00:00.000Z');

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

function capturingLogger() {
  const events: {
    level: 'info' | 'error';
    event: string;
    fields?: OutboxConsumerLogFields;
  }[] = [];
  return {
    events,
    logger: {
      info(event: string, fields?: OutboxConsumerLogFields) {
        events.push({ level: 'info' as const, event, fields });
      },
      error(event: string, fields?: OutboxConsumerLogFields) {
        events.push({ level: 'error' as const, event, fields });
      },
    },
    serialized() {
      return JSON.stringify(events);
    },
  };
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
    `INSERT INTO homes (id, name, timezone, archived_at, updated_at)
     VALUES ($1, $2, 'UTC', NULL, NOW())`,
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

async function insertOpenManualTask(
  pool: Pool,
  input: {
    id: string;
    homeId: string;
    title: string;
    assignedMembershipId?: string | null;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO task_instances (
       id, home_id, source, status, title, scheduled_for,
       assigned_membership_id, task_definition_id, completed_at,
       created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, 'MANUAL', 'OPEN', $3, NULL, $4::uuid,
       NULL, NULL, $5::timestamptz, $5::timestamptz
     )`,
    [
      input.id,
      input.homeId,
      input.title,
      input.assignedMembershipId ?? null,
      CREATED,
    ],
  );
}

async function cleanup(
  pool: Pool,
  input: { homeIds: string[]; userIds: string[] },
): Promise<void> {
  if (input.homeIds.length > 0) {
    await pool.query(
      'DELETE FROM activity_recipients WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query('DELETE FROM activities WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query(
      'DELETE FROM maintenance_audiences WHERE home_id = ANY($1)',
      [input.homeIds],
    );
    await pool.query(
      'DELETE FROM maintenance_entries WHERE home_id = ANY($1)',
      [input.homeIds],
    );
    await pool.query('DELETE FROM supply_claims WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query('DELETE FROM supply_entries WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query('DELETE FROM task_instances WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query('DELETE FROM outbox_events WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
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
    await pool.query('DELETE FROM homes WHERE id = ANY($1)', [input.homeIds]);
  }
  if (input.userIds.length > 0) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [input.userIds]);
  }
}

async function drainActivity(
  pool: Pool,
  extras: readonly OutboxEventHandler[] = [],
  logger = capturingLogger(),
) {
  const consumer = createOutboxConsumerFromPool(pool, {
    registry: createOutboxHandlerRegistry([
      createActivityOutboxHandlerFromPool(pool),
      ...extras,
    ]),
    logger: logger.logger,
  });
  let processedCount = 0;
  let failedCount = 0;
  for (;;) {
    const result = await consumer.drain({ batchSize: 20 });
    processedCount += result.processedCount;
    failedCount += result.failedCount;
    if (!result.moreWorkLikely) {
      break;
    }
  }
  return {
    result: Object.freeze({ processedCount, failedCount }),
    logger,
  };
}

async function activityRows(
  pool: Pool,
  homeId: string,
): Promise<
  readonly {
    id: string;
    event_type: string;
    visibility_class: string;
    actor_membership_id: string | null;
    source_entity_id: string;
    source_outbox_event_id: string;
    source_entity_type: string;
  }[]
> {
  const result = await pool.query<{
    id: string;
    event_type: string;
    visibility_class: string;
    actor_membership_id: string | null;
    source_entity_id: string;
    source_outbox_event_id: string;
    source_entity_type: string;
  }>(
    `SELECT id, event_type, visibility_class, actor_membership_id,
            source_entity_id, source_outbox_event_id, source_entity_type
     FROM activities
     WHERE home_id = $1
     ORDER BY occurred_at ASC, id ASC`,
    [homeId],
  );
  return result.rows;
}

async function recipientIds(
  pool: Pool,
  activityId: string,
): Promise<readonly string[]> {
  const result = await pool.query<{ membership_id: string }>(
    `SELECT membership_id
     FROM activity_recipients
     WHERE activity_id = $1
     ORDER BY membership_id ASC`,
    [activityId],
  );
  return result.rows.map((row) => row.membership_id);
}

async function outboxProcessedAt(
  pool: Pool,
  eventId: string,
): Promise<Date | null> {
  const result = await pool.query<{ processed_at: Date | null }>(
    'SELECT processed_at FROM outbox_events WHERE event_id = $1',
    [eventId],
  );
  return result.rows[0]?.processed_at ?? null;
}

async function pendingEventIds(
  pool: Pool,
  homeId: string,
  eventType: string,
): Promise<readonly string[]> {
  const result = await pool.query<{ event_id: string }>(
    `SELECT event_id FROM outbox_events
     WHERE home_id = $1
       AND event_type = $2
       AND processed_at IS NULL
     ORDER BY created_at ASC, event_id ASC`,
    [homeId, eventType],
  );
  return result.rows.map((row) => row.event_id);
}

async function insertOutboxEvent(
  pool: Pool,
  input: {
    eventId: string;
    eventType: string;
    homeId: string;
    payload: object;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO outbox_events (
       event_id, event_type, occurred_at, available_at, home_id, payload
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      input.eventId,
      input.eventType,
      new Date('2026-09-13T18:00:00.000Z'),
      new Date('2026-01-01T00:00:00.000Z'),
      input.homeId,
      JSON.stringify(input.payload),
    ],
  );
}

void describe('Task and Supply Activity projection PostgreSQL', () => {
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
    'projects HOME_VISIBLE Task/Supply Activity with exact tenure actors',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const complete = createCompleteTaskFromPool(database.pool);
      const createSupply = createCreateSupplyEntryFromPool(database.pool);
      const claim = createClaimSupplyEntryFromPool(database.pool);
      const obtain = createMarkSupplyEntryObtainedFromPool(database.pool);
      const createMaintenance = createCreateMaintenanceEntryFromPool(
        database.pool,
      );
      const leave = createLeaveMembershipFromPool(database.pool);
      const activities = createActivityRepository(database.pool);
      const userAlex = randomUUID();
      const userJamie = randomUUID();
      const userTaylor = randomUUID();
      const userOther = randomUUID();
      const homeA = createUuidV7();
      const homeB = createUuidV7();
      const alexA = createUuidV7();
      const jamie = createUuidV7();
      const taylor = createUuidV7();
      const otherHomeMembership = createUuidV7();
      const taskId = createUuidV7();
      const alexActor = actor({
        userId: userAlex,
        membershipId: alexA,
        homeId: homeA,
        role: 'ROOMMATE',
      });
      const jamieActor = actor({
        userId: userJamie,
        membershipId: jamie,
        homeId: homeA,
        role: 'ROOMMATE',
      });

      try {
        await insertUser(database.pool, userAlex);
        await insertUser(database.pool, userJamie);
        await insertUser(database.pool, userTaylor);
        await insertUser(database.pool, userOther);
        await insertHome(database.pool, { id: homeA, name: 'Home A' });
        await insertHome(database.pool, { id: homeB, name: 'Home B' });
        await insertMembership(database.pool, {
          id: alexA,
          homeId: homeA,
          userId: userAlex,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: jamie,
          homeId: homeA,
          userId: userJamie,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: taylor,
          homeId: homeA,
          userId: userTaylor,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: otherHomeMembership,
          homeId: homeB,
          userId: userOther,
          role: 'ROOMMATE',
        });

        await insertOpenManualTask(database.pool, {
          id: taskId,
          homeId: homeA,
          title: TITLE_SENTINEL,
          assignedMembershipId: alexA,
        });
        await complete({
          actor: jamieActor,
          homeId: homeA,
          taskId,
        });

        const supply = await createSupply({
          actor: jamieActor,
          homeId: homeA,
          title: TITLE_SENTINEL,
        });
        await claim({
          actor: jamieActor,
          homeId: homeA,
          supplyEntryId: supply.id,
        });
        await obtain({
          actor: alexActor,
          homeId: homeA,
          supplyEntryId: supply.id,
        });

        const privateMaint = await createMaintenance({
          actor: jamieActor,
          homeId: homeA,
          visibility: 'PRIVATE',
          title: TITLE_SENTINEL,
          audienceMembershipIds: [],
        });

        const logs = capturingLogger();
        const drained = await drainActivity(database.pool, [], logs);
        assert.equal(drained.result.failedCount, 0);
        assert.ok(drained.result.processedCount >= 3);

        const rows = await activityRows(database.pool, homeA);
        const taskActivity = rows.find(
          (row) =>
            row.source_entity_id === taskId &&
            row.event_type === TASK_COMPLETED_V1,
        );
        const supplyActivity = rows.find(
          (row) =>
            row.source_entity_id === supply.id &&
            row.event_type === SUPPLY_OBTAINED_V1,
        );
        const privateActivity = rows.find(
          (row) =>
            row.source_entity_id === privateMaint.id &&
            row.event_type === MAINTENANCE_CREATED_V1,
        );
        assert.ok(taskActivity);
        assert.ok(supplyActivity);
        assert.ok(privateActivity);
        assert.equal(taskActivity.visibility_class, 'HOME_VISIBLE');
        assert.equal(taskActivity.source_entity_type, 'TASK');
        assert.equal(taskActivity.source_entity_id, taskId);
        assert.equal(taskActivity.actor_membership_id, jamie);
        assert.notEqual(taskActivity.actor_membership_id, alexA);
        assert.deepEqual(
          await recipientIds(database.pool, taskActivity.id),
          [],
        );

        assert.equal(supplyActivity.visibility_class, 'HOME_VISIBLE');
        assert.equal(supplyActivity.source_entity_type, 'SUPPLY');
        assert.equal(supplyActivity.source_entity_id, supply.id);
        assert.equal(supplyActivity.actor_membership_id, alexA);
        assert.notEqual(supplyActivity.actor_membership_id, jamie);
        assert.deepEqual(
          await recipientIds(database.pool, supplyActivity.id),
          [],
        );

        const dump = JSON.stringify(
          await database.pool.query(
            `SELECT * FROM activities WHERE home_id = $1`,
            [homeA],
          ),
        );
        assert.equal(dump.includes(TITLE_SENTINEL), false);
        assert.equal(dump.includes(userAlex), false);
        assert.equal(logs.serialized().includes(TITLE_SENTINEL), false);

        const alexVisible = await activities.listVisibleByHome(homeA, alexA);
        const jamieVisible = await activities.listVisibleByHome(homeA, jamie);
        const taylorVisible = await activities.listVisibleByHome(homeA, taylor);
        assert.ok(alexVisible);
        assert.ok(jamieVisible);
        assert.ok(taylorVisible);
        assert.equal(
          alexVisible.some((item) => item.id === taskActivity.id),
          true,
        );
        assert.equal(
          alexVisible.some((item) => item.id === supplyActivity.id),
          true,
        );
        assert.equal(
          jamieVisible.some((item) => item.id === taskActivity.id),
          true,
        );
        assert.equal(
          jamieVisible.some((item) => item.id === supplyActivity.id),
          true,
        );
        assert.equal(
          taylorVisible.some((item) => item.id === taskActivity.id),
          true,
        );
        assert.equal(
          taylorVisible.some((item) => item.id === supplyActivity.id),
          true,
        );
        assert.equal(
          taylorVisible.some((item) => item.id === privateActivity.id),
          false,
        );
        assert.equal(
          taylorVisible.some(
            (item) => item.visibilityClass === 'SOURCE_AUTHORIZED',
          ),
          false,
        );

        assert.equal(
          await activities.listVisibleByHome(homeA, otherHomeMembership),
          null,
        );

        await leave({
          actor: alexActor,
          homeId: homeA,
          membershipId: alexA,
        });
        assert.equal(await activities.listVisibleByHome(homeA, alexA), null);

        const alexB = createUuidV7();
        await insertMembership(database.pool, {
          id: alexB,
          homeId: homeA,
          userId: userAlex,
          role: 'ROOMMATE',
        });
        const alexBVisible = await activities.listVisibleByHome(homeA, alexB);
        assert.ok(alexBVisible);
        assert.equal(
          alexBVisible.some((item) => item.id === taskActivity.id),
          true,
        );
        assert.equal(
          alexBVisible.some((item) => item.id === supplyActivity.id),
          true,
        );
        const afterRejoin = await activityRows(database.pool, homeA);
        const taskAfter = afterRejoin.find((row) => row.id === taskActivity.id);
        const supplyAfter = afterRejoin.find(
          (row) => row.id === supplyActivity.id,
        );
        assert.equal(taskAfter?.actor_membership_id, jamie);
        assert.notEqual(taskAfter?.actor_membership_id, alexB);
        assert.equal(supplyAfter?.actor_membership_id, alexA);
        assert.notEqual(supplyAfter?.actor_membership_id, alexB);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeA, homeB],
          userIds: [userAlex, userJamie, userTaylor, userOther],
        });
        await database.close();
      }
    },
  );

  void it(
    'is idempotent, no-ops missing source, and fails closed on integrity',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const complete = createCompleteTaskFromPool(database.pool);
      const createSupply = createCreateSupplyEntryFromPool(database.pool);
      const obtain = createMarkSupplyEntryObtainedFromPool(database.pool);
      const userId = randomUUID();
      const homeA = createUuidV7();
      const homeB = createUuidV7();
      const membershipId = createUuidV7();
      const taskId = createUuidV7();
      const openTaskId = createUuidV7();

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, { id: homeA, name: 'Integrity A' });
        await insertHome(database.pool, { id: homeB, name: 'Integrity B' });
        await insertMembership(database.pool, {
          id: membershipId,
          homeId: homeA,
          userId,
          role: 'ADMIN',
        });
        const admin = actor({
          userId,
          membershipId,
          homeId: homeA,
          role: 'ADMIN',
        });

        await insertOpenManualTask(database.pool, {
          id: taskId,
          homeId: homeA,
          title: TITLE_SENTINEL,
        });
        await complete({
          actor: admin,
          homeId: homeA,
          taskId,
        });
        const supply = await createSupply({
          actor: admin,
          homeId: homeA,
          title: TITLE_SENTINEL,
        });
        await obtain({
          actor: admin,
          homeId: homeA,
          supplyEntryId: supply.id,
        });
        await drainActivity(database.pool);
        assert.equal((await activityRows(database.pool, homeA)).length, 2);

        const eventIds = (
          await database.pool.query<{ event_id: string }>(
            `SELECT event_id FROM outbox_events
             WHERE home_id = $1
               AND event_type IN ($2, $3)
             ORDER BY created_at ASC`,
            [homeA, TASK_COMPLETED_V1, SUPPLY_OBTAINED_V1],
          )
        ).rows.map((row) => row.event_id);
        await database.pool.query(
          `UPDATE outbox_events SET processed_at = NULL, dead_at = NULL,
                  lease_owner = NULL, leased_at = NULL, lease_until = NULL
           WHERE event_id = ANY($1::uuid[])`,
          [eventIds],
        );
        const replay = await drainActivity(database.pool);
        assert.equal(replay.result.failedCount, 0);
        assert.equal((await activityRows(database.pool, homeA)).length, 2);

        const missingTaskId = createUuidV7();
        await insertOpenManualTask(database.pool, {
          id: missingTaskId,
          homeId: homeA,
          title: TITLE_SENTINEL,
        });
        await complete({
          actor: admin,
          homeId: homeA,
          taskId: missingTaskId,
        });
        const missingEventId = (
          await pendingEventIds(database.pool, homeA, TASK_COMPLETED_V1)
        )[0];
        assert.ok(missingEventId);
        await database.pool.query('DELETE FROM task_instances WHERE id = $1', [
          missingTaskId,
        ]);
        const missingDrain = await drainActivity(database.pool);
        assert.equal(missingDrain.result.failedCount, 0);
        assert.ok(await outboxProcessedAt(database.pool, missingEventId));
        assert.equal(
          (await activityRows(database.pool, homeA)).filter(
            (row) => row.source_entity_id === missingTaskId,
          ).length,
          0,
        );

        const missingSupply = await createSupply({
          actor: admin,
          homeId: homeA,
          title: TITLE_SENTINEL,
        });
        await obtain({
          actor: admin,
          homeId: homeA,
          supplyEntryId: missingSupply.id,
        });
        const missingSupplyEventId = (
          await pendingEventIds(database.pool, homeA, SUPPLY_OBTAINED_V1)
        )[0];
        assert.ok(missingSupplyEventId);
        await database.pool.query('DELETE FROM supply_entries WHERE id = $1', [
          missingSupply.id,
        ]);
        const missingSupplyDrain = await drainActivity(database.pool);
        assert.equal(missingSupplyDrain.result.failedCount, 0);
        assert.ok(await outboxProcessedAt(database.pool, missingSupplyEventId));

        await insertOpenManualTask(database.pool, {
          id: openTaskId,
          homeId: homeA,
          title: TITLE_SENTINEL,
        });
        const mismatchId = createUuidV7();
        await insertOutboxEvent(database.pool, {
          eventId: mismatchId,
          eventType: TASK_COMPLETED_V1,
          homeId: homeB,
          payload: { taskInstanceId: openTaskId },
        });
        const mismatchLogs = capturingLogger();
        const mismatchDrain = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([
            createActivityOutboxHandlerFromPool(database.pool),
          ]),
          logger: mismatchLogs.logger,
          retryPolicy: ZERO_BACKOFF,
        });
        const mismatchResult = await mismatchDrain.drain({ batchSize: 1 });
        assert.equal(mismatchResult.failedCount, 1);
        assert.equal(await outboxProcessedAt(database.pool, mismatchId), null);
        assert.equal(
          mismatchLogs.events.some(
            (entry) =>
              entry.fields?.errorClass ===
              new ActivityProjectionIntegrityError().name,
          ),
          true,
        );

        const impossibleTaskId = createUuidV7();
        await insertOutboxEvent(database.pool, {
          eventId: impossibleTaskId,
          eventType: TASK_COMPLETED_V1,
          homeId: homeA,
          payload: { taskInstanceId: openTaskId },
        });
        const impossibleTask = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([
            createActivityOutboxHandlerFromPool(database.pool),
          ]),
          retryPolicy: ZERO_BACKOFF,
        });
        const impossibleTaskResult = await impossibleTask.drain({
          batchSize: 1,
        });
        assert.equal(impossibleTaskResult.failedCount, 1);
        assert.equal(
          await outboxProcessedAt(database.pool, impossibleTaskId),
          null,
        );

        const openSupply = await createSupply({
          actor: admin,
          homeId: homeA,
          title: TITLE_SENTINEL,
        });
        const supplyMismatchId = createUuidV7();
        await insertOutboxEvent(database.pool, {
          eventId: supplyMismatchId,
          eventType: SUPPLY_OBTAINED_V1,
          homeId: homeB,
          payload: { supplyEntryId: openSupply.id },
        });
        const supplyMismatch = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([
            createActivityOutboxHandlerFromPool(database.pool),
          ]),
          retryPolicy: ZERO_BACKOFF,
        });
        assert.equal(
          (await supplyMismatch.drain({ batchSize: 1 })).failedCount,
          1,
        );

        const impossibleSupplyId = createUuidV7();
        await insertOutboxEvent(database.pool, {
          eventId: impossibleSupplyId,
          eventType: SUPPLY_OBTAINED_V1,
          homeId: homeA,
          payload: { supplyEntryId: openSupply.id },
        });
        const impossibleSupply = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([
            createActivityOutboxHandlerFromPool(database.pool),
          ]),
          retryPolicy: ZERO_BACKOFF,
        });
        assert.equal(
          (await impossibleSupply.drain({ batchSize: 1 })).failedCount,
          1,
        );
        assert.equal(
          await outboxProcessedAt(database.pool, impossibleSupplyId),
          null,
        );
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeA, homeB],
          userIds: [userId],
        });
        await database.close();
      }
    },
  );

  void it(
    'rolls back Activity when a second task.completed.v1 handler fails',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const complete = createCompleteTaskFromPool(database.pool);
      const userId = randomUUID();
      const homeId = createUuidV7();
      const membershipId = createUuidV7();
      const taskId = createUuidV7();
      let failSecond = true;

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, { id: homeId, name: 'Multi handler' });
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ADMIN',
        });
        await insertOpenManualTask(database.pool, {
          id: taskId,
          homeId,
          title: TITLE_SENTINEL,
        });
        await complete({
          actor: actor({
            userId,
            membershipId,
            homeId,
            role: 'ADMIN',
          }),
          homeId,
          taskId,
        });
        const pending = await pendingEventIds(
          database.pool,
          homeId,
          TASK_COMPLETED_V1,
        );
        const eventId = pending[0];
        assert.ok(eventId);

        const secondHandler: OutboxEventHandler = Object.freeze({
          handlerId: 'synthetic_sink',
          eventTypes: [TASK_COMPLETED_V1],
          handle() {
            if (failSecond) {
              return Promise.reject(new Error('synthetic handler failure'));
            }
            return Promise.resolve();
          },
        });
        const first = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([
            createActivityOutboxHandlerFromPool(database.pool),
            secondHandler,
          ]),
          retryPolicy: ZERO_BACKOFF,
        });
        const firstResult = await first.drain({ batchSize: 1 });
        assert.equal(firstResult.failedCount, 1);
        assert.equal(await outboxProcessedAt(database.pool, eventId), null);
        assert.equal((await activityRows(database.pool, homeId)).length, 0);

        failSecond = false;
        const second = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([
            createActivityOutboxHandlerFromPool(database.pool),
            secondHandler,
          ]),
          retryPolicy: ZERO_BACKOFF,
        });
        const secondResult = await second.drain({ batchSize: 1 });
        assert.equal(secondResult.failedCount, 0);
        assert.ok(await outboxProcessedAt(database.pool, eventId));
        assert.equal((await activityRows(database.pool, homeId)).length, 1);

        await database.pool.query(
          `UPDATE outbox_events SET processed_at = NULL, dead_at = NULL,
                  lease_owner = NULL, leased_at = NULL, lease_until = NULL
           WHERE event_id = $1`,
          [eventId],
        );
        const replay = await second.drain({ batchSize: 1 });
        assert.equal(replay.failedCount, 0);
        assert.equal((await activityRows(database.pool, homeId)).length, 1);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userId],
        });
        await database.close();
      }
    },
  );

  void it(
    'registers activity for all seven current event types with exact dispatch',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const handler = createActivityOutboxHandlerFromPool(database.pool);
      assert.equal(handler.handlerId, ACTIVITY_OUTBOX_HANDLER_ID);
      assert.deepEqual(handler.eventTypes, [
        MAINTENANCE_CREATED_V1,
        MAINTENANCE_RESOLVED_V1,
        TASK_COMPLETED_V1,
        SUPPLY_OBTAINED_V1,
        'membership.started.v1',
        'membership.ended.v1',
        'membership.role_changed.v1',
      ]);
      const registry = createOutboxHandlerRegistry([handler]);
      assert.equal(registry.handlersFor(TASK_COMPLETED_V1).length, 1);
      assert.equal(registry.handlersFor(SUPPLY_OBTAINED_V1).length, 1);
      assert.equal(registry.handlersFor('membership.started.v1').length, 1);
      assert.equal(registry.handlersFor('membership.ended.v1').length, 1);
      assert.equal(
        registry.handlersFor('membership.role_changed.v1').length,
        1,
      );
      assert.equal(registry.handlersFor('task.completed.v2').length, 0);
      assert.equal(registry.handlersFor('supply.obtained.v2').length, 0);
      assert.equal(registry.handlersFor('task.created.v1').length, 0);
      await database.close();
    },
  );

  void it(
    'leaves processed_at null on Task Activity insert failure and succeeds on retry',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const complete = createCompleteTaskFromPool(database.pool);
      const realActivity = createActivityRepository(database.pool);
      const userId = randomUUID();
      const homeId = createUuidV7();
      const membershipId = createUuidV7();
      const taskId = createUuidV7();
      let failInsert = true;

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, { id: homeId, name: 'Retry' });
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ADMIN',
        });
        await insertOpenManualTask(database.pool, {
          id: taskId,
          homeId,
          title: TITLE_SENTINEL,
        });
        await complete({
          actor: actor({
            userId,
            membershipId,
            homeId,
            role: 'ADMIN',
          }),
          homeId,
          taskId,
        });
        const pending = await pendingEventIds(
          database.pool,
          homeId,
          TASK_COMPLETED_V1,
        );
        const eventId = pending[0];
        assert.ok(eventId);

        const failing = createActivityOutboxHandler({
          findMaintenanceActivitySource,
          findTaskActivitySource,
          findSupplyActivitySource,
          findMembershipStartedActivitySource,
          findMembershipEndedActivitySource,
          findMembershipRoleTransitionActivitySource,
          activity: {
            async insertHomeVisibleActivity(tx, activity) {
              if (failInsert) {
                throw new ActivityPersistenceError();
              }
              return realActivity.insertHomeVisibleActivity(tx, activity);
            },
            insertSourceAuthorizedActivity: (tx, activity, recipients) =>
              realActivity.insertSourceAuthorizedActivity(
                tx,
                activity,
                recipients,
              ),
          },
          ids: systemUuidV7,
        });
        const first = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([failing]),
          retryPolicy: ZERO_BACKOFF,
        });
        const firstResult = await first.drain({ batchSize: 1 });
        assert.equal(firstResult.failedCount, 1);
        assert.equal(await outboxProcessedAt(database.pool, eventId), null);
        assert.equal((await activityRows(database.pool, homeId)).length, 0);

        failInsert = false;
        const second = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([failing]),
          retryPolicy: ZERO_BACKOFF,
        });
        const secondResult = await second.drain({ batchSize: 1 });
        assert.equal(secondResult.failedCount, 0);
        assert.equal(secondResult.processedCount, 1);
        assert.ok(await outboxProcessedAt(database.pool, eventId));
        assert.equal((await activityRows(database.pool, homeId)).length, 1);
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
