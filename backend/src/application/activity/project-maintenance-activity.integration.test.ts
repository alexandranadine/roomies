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
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
import { systemUuidV7 } from '../../platform/ids/uuid-v7.js';
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
import { createResolveMaintenanceEntryFromPool } from '../maintenance/resolve-maintenance-entry.js';
import { ActivityProjectionIntegrityError } from './errors.js';
import {
  ACTIVITY_OUTBOX_HANDLER_ID,
  createActivityOutboxHandler,
  createActivityOutboxHandlerFromPool,
} from './outbox-handler.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const TITLE_SENTINEL = 'SENTINEL_MAINT_TITLE_LEAK_M63';
const DETAILS_SENTINEL = 'SENTINEL_MAINT_DETAILS_LEAK_M63';
const ZERO_BACKOFF: OutboxRetryPolicy = Object.freeze({
  maxAttempts: 8,
  backoffMs: () => 0,
});

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

async function cleanup(
  pool: Pool,
  input: { homeIds: string[]; userIds: string[] },
): Promise<void> {
  if (input.homeIds.length > 0) {
    await pool.query(
      'DELETE FROM activity_recipients WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query('DELETE FROM activities WHERE home_id = ANY($1::uuid[])', [
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

async function pendingMaintenanceEventIds(
  pool: Pool,
  homeId: string,
): Promise<readonly string[]> {
  const result = await pool.query<{ event_id: string }>(
    `SELECT event_id FROM outbox_events
     WHERE home_id = $1
       AND event_type LIKE 'maintenance%'
       AND processed_at IS NULL
     ORDER BY created_at ASC, event_id ASC`,
    [homeId],
  );
  return result.rows.map((row) => row.event_id);
}

async function insertOutboxEvent(
  pool: Pool,
  input: {
    eventId: string;
    eventType: string;
    homeId: string;
    maintenanceEntryId: string;
    occurredAt?: Date;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO outbox_events (
       event_id, event_type, occurred_at, available_at, home_id, payload
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      input.eventId,
      input.eventType,
      input.occurredAt ?? new Date('2026-09-13T18:00:00.000Z'),
      new Date('2026-01-01T00:00:00.000Z'),
      input.homeId,
      JSON.stringify({ maintenanceEntryId: input.maintenanceEntryId }),
    ],
  );
}

void describe('Maintenance Activity projection PostgreSQL', () => {
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
    'projects HOUSEHOLD and PRIVATE create/resolve with exact tenure privacy',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const create = createCreateMaintenanceEntryFromPool(database.pool);
      const resolve = createResolveMaintenanceEntryFromPool(database.pool);
      const leave = createLeaveMembershipFromPool(database.pool);
      const activities = createActivityRepository(database.pool);
      const userAlex = randomUUID();
      const userJamie = randomUUID();
      const userTaylor = randomUUID();
      const homeId = createUuidV7();
      const alexA = createUuidV7();
      const jamie = createUuidV7();
      const taylor = createUuidV7();
      const alex = actor({
        userId: userAlex,
        membershipId: alexA,
        homeId,
        role: 'ROOMMATE',
      });
      const jamieActor = actor({
        userId: userJamie,
        membershipId: jamie,
        homeId,
        role: 'ROOMMATE',
      });

      try {
        await insertUser(database.pool, userAlex);
        await insertUser(database.pool, userJamie);
        await insertUser(database.pool, userTaylor);
        await insertHome(database.pool, { id: homeId, name: 'Projection' });
        await insertMembership(database.pool, {
          id: alexA,
          homeId,
          userId: userAlex,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: jamie,
          homeId,
          userId: userJamie,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: taylor,
          homeId,
          userId: userTaylor,
          role: 'ADMIN',
        });

        const household = await create({
          actor: alex,
          homeId,
          visibility: 'HOUSEHOLD',
          title: TITLE_SENTINEL,
          details: DETAILS_SENTINEL,
        });
        const privateM1 = await create({
          actor: alex,
          homeId,
          visibility: 'PRIVATE',
          title: TITLE_SENTINEL,
          details: DETAILS_SENTINEL,
          audienceMembershipIds: [jamie],
        });
        await resolve({
          actor: jamieActor,
          homeId,
          maintenanceEntryId: household.id,
        });
        await resolve({
          actor: alex,
          homeId,
          maintenanceEntryId: privateM1.id,
        });

        const logs = capturingLogger();
        const drained = await drainActivity(database.pool, [], logs);
        assert.equal(drained.result.failedCount, 0);
        assert.ok(drained.result.processedCount >= 4);

        const rows = await activityRows(database.pool, homeId);
        assert.equal(rows.length, 4);
        for (const row of rows) {
          assert.equal(row.source_entity_type, 'MAINTENANCE');
        }

        const householdCreate = rows.find(
          (row) =>
            row.source_entity_id === household.id &&
            row.event_type === MAINTENANCE_CREATED_V1,
        );
        const householdResolve = rows.find(
          (row) =>
            row.source_entity_id === household.id &&
            row.event_type === MAINTENANCE_RESOLVED_V1,
        );
        const privateCreate = rows.find(
          (row) =>
            row.source_entity_id === privateM1.id &&
            row.event_type === MAINTENANCE_CREATED_V1,
        );
        const privateResolve = rows.find(
          (row) =>
            row.source_entity_id === privateM1.id &&
            row.event_type === MAINTENANCE_RESOLVED_V1,
        );
        assert.ok(householdCreate);
        assert.ok(householdResolve);
        assert.ok(privateCreate);
        assert.ok(privateResolve);
        assert.equal(householdCreate.visibility_class, 'HOME_VISIBLE');
        assert.equal(householdResolve.visibility_class, 'HOME_VISIBLE');
        assert.equal(householdCreate.actor_membership_id, alexA);
        assert.equal(householdResolve.actor_membership_id, jamie);
        assert.deepEqual(
          await recipientIds(database.pool, householdCreate.id),
          [],
        );
        assert.deepEqual(
          await recipientIds(database.pool, householdResolve.id),
          [],
        );
        assert.equal(privateCreate.visibility_class, 'SOURCE_AUTHORIZED');
        assert.equal(privateResolve.visibility_class, 'SOURCE_AUTHORIZED');
        assert.equal(privateCreate.actor_membership_id, alexA);
        assert.equal(privateResolve.actor_membership_id, alexA);
        const expectedAudience = [alexA, jamie].sort((left, right) =>
          left < right ? -1 : left > right ? 1 : 0,
        );
        assert.deepEqual(
          await recipientIds(database.pool, privateCreate.id),
          expectedAudience,
        );
        assert.deepEqual(
          await recipientIds(database.pool, privateResolve.id),
          expectedAudience,
        );
        assert.equal(
          (await recipientIds(database.pool, privateCreate.id)).includes(
            taylor,
          ),
          false,
        );

        const tableDump = JSON.stringify(
          await database.pool.query(
            `SELECT * FROM activities WHERE home_id = $1`,
            [homeId],
          ),
        );
        const recipientDump = JSON.stringify(
          await database.pool.query(
            `SELECT * FROM activity_recipients WHERE home_id = $1`,
            [homeId],
          ),
        );
        assert.equal(tableDump.includes(TITLE_SENTINEL), false);
        assert.equal(tableDump.includes(DETAILS_SENTINEL), false);
        assert.equal(recipientDump.includes(userAlex), false);
        assert.equal(recipientDump.includes(userJamie), false);
        assert.equal(recipientDump.includes('email'), false);
        assert.equal(logs.serialized().includes(TITLE_SENTINEL), false);
        assert.equal(logs.serialized().includes(DETAILS_SENTINEL), false);
        assert.equal(logs.serialized().includes(alexA), false);
        for (const entry of logs.events) {
          assert.ok(
            entry.fields === undefined ||
              !('payload' in (entry.fields as object)),
          );
        }

        const alexVisible = await activities.listVisibleByHome(homeId, alexA);
        const jamieVisible = await activities.listVisibleByHome(homeId, jamie);
        const taylorVisible = await activities.listVisibleByHome(
          homeId,
          taylor,
        );
        assert.ok(alexVisible);
        assert.ok(jamieVisible);
        assert.ok(taylorVisible);
        const alexIds = alexVisible.map((item) => item.sourceEntityId).sort();
        const jamieIds = jamieVisible.map((item) => item.sourceEntityId).sort();
        const taylorIds = taylorVisible
          .map((item) => item.sourceEntityId)
          .sort();
        assert.deepEqual(
          [...new Set(alexIds)],
          [household.id, privateM1.id].sort(),
        );
        assert.deepEqual(
          [...new Set(jamieIds)],
          [household.id, privateM1.id].sort(),
        );
        assert.deepEqual([...new Set(taylorIds)], [household.id]);
        assert.equal(
          taylorVisible.some((item) => item.sourceEntityId === privateM1.id),
          false,
        );

        await leave({
          actor: alex,
          homeId,
          membershipId: alexA,
        });
        const alexB = createUuidV7();
        await insertMembership(database.pool, {
          id: alexB,
          homeId,
          userId: userAlex,
          role: 'ROOMMATE',
        });
        assert.deepEqual(
          await recipientIds(database.pool, privateCreate.id),
          expectedAudience,
        );
        const alexBVisible = await activities.listVisibleByHome(homeId, alexB);
        assert.ok(alexBVisible);
        assert.equal(
          alexBVisible.some((item) => item.id === privateCreate.id),
          false,
        );
        assert.equal(
          alexBVisible.some((item) => item.sourceEntityId === household.id),
          true,
        );

        const privateB = await create({
          actor: {
            userId: userAlex,
            membershipId: alexB,
            homeId,
            role: 'ROOMMATE',
          },
          homeId,
          visibility: 'PRIVATE',
          title: TITLE_SENTINEL,
          audienceMembershipIds: [],
        });
        await drainActivity(database.pool);
        const afterRejoin = await activities.listVisibleByHome(homeId, alexB);
        assert.ok(afterRejoin);
        assert.equal(
          afterRejoin.some((item) => item.sourceEntityId === privateB.id),
          true,
        );
        assert.equal(
          afterRejoin.some((item) => item.sourceEntityId === privateM1.id),
          false,
        );
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userAlex, userJamie, userTaylor],
        });
        await database.close();
      }
    },
  );

  void it(
    'keeps hidden PRIVATE Activity out of each actor visibility query',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const create = createCreateMaintenanceEntryFromPool(database.pool);
      const activities = createActivityRepository(database.pool);
      const userAlex = randomUUID();
      const userJamie = randomUUID();
      const userTaylor = randomUUID();
      const userSam = randomUUID();
      const homeId = createUuidV7();
      const alex = createUuidV7();
      const jamie = createUuidV7();
      const taylor = createUuidV7();
      const sam = createUuidV7();

      try {
        await insertUser(database.pool, userAlex);
        await insertUser(database.pool, userJamie);
        await insertUser(database.pool, userTaylor);
        await insertUser(database.pool, userSam);
        await insertHome(database.pool, { id: homeId, name: 'Hidden proof' });
        await insertMembership(database.pool, {
          id: alex,
          homeId,
          userId: userAlex,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: jamie,
          homeId,
          userId: userJamie,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: taylor,
          homeId,
          userId: userTaylor,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: sam,
          homeId,
          userId: userSam,
          role: 'ROOMMATE',
        });

        const m1 = await create({
          actor: actor({
            userId: userAlex,
            membershipId: alex,
            homeId,
            role: 'ROOMMATE',
          }),
          homeId,
          visibility: 'PRIVATE',
          title: 'M1',
          audienceMembershipIds: [],
        });
        const household = await create({
          actor: actor({
            userId: userTaylor,
            membershipId: taylor,
            homeId,
            role: 'ADMIN',
          }),
          homeId,
          visibility: 'HOUSEHOLD',
          title: 'H',
        });
        const m2 = await create({
          actor: actor({
            userId: userJamie,
            membershipId: jamie,
            homeId,
            role: 'ROOMMATE',
          }),
          homeId,
          visibility: 'PRIVATE',
          title: 'M2',
          audienceMembershipIds: [],
        });
        for (let index = 0; index < 8; index += 1) {
          await create({
            actor: actor({
              userId: userSam,
              membershipId: sam,
              homeId,
              role: 'ROOMMATE',
            }),
            homeId,
            visibility: 'PRIVATE',
            title: `hidden-${index}`,
            audienceMembershipIds: [],
          });
        }
        await drainActivity(database.pool);

        const alexVisible = await activities.listVisibleByHome(homeId, alex);
        const jamieVisible = await activities.listVisibleByHome(homeId, jamie);
        const taylorVisible = await activities.listVisibleByHome(
          homeId,
          taylor,
        );
        assert.ok(alexVisible);
        assert.ok(jamieVisible);
        assert.ok(taylorVisible);
        assert.deepEqual(
          alexVisible.map((item) => item.sourceEntityId).sort(),
          [household.id, m1.id].sort(),
        );
        assert.deepEqual(
          jamieVisible.map((item) => item.sourceEntityId).sort(),
          [household.id, m2.id].sort(),
        );
        assert.deepEqual(
          taylorVisible.map((item) => item.sourceEntityId),
          [household.id],
        );
        assert.equal(
          alexVisible.some((item) => item.sourceEntityId === m2.id),
          false,
        );
        assert.equal(
          jamieVisible.some((item) => item.sourceEntityId === m1.id),
          false,
        );
        assert.equal(
          taylorVisible.some(
            (item) => item.visibilityClass === 'SOURCE_AUTHORIZED',
          ),
          false,
        );
        const all = await activityRows(database.pool, homeId);
        assert.ok(all.length > alexVisible.length);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userAlex, userJamie, userTaylor, userSam],
        });
        await database.close();
      }
    },
  );

  void it(
    'is idempotent across duplicate delivery, create+resolve, and retry',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const create = createCreateMaintenanceEntryFromPool(database.pool);
      const resolve = createResolveMaintenanceEntryFromPool(database.pool);
      const userId = randomUUID();
      const homeId = createUuidV7();
      const membershipId = createUuidV7();

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, { id: homeId, name: 'Idempotent' });
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ADMIN',
        });
        const admin = actor({
          userId,
          membershipId,
          homeId,
          role: 'ADMIN',
        });
        const created = await create({
          actor: admin,
          homeId,
          visibility: 'HOUSEHOLD',
          title: TITLE_SENTINEL,
        });
        await resolve({
          actor: admin,
          homeId,
          maintenanceEntryId: created.id,
        });
        await drainActivity(database.pool);
        assert.equal((await activityRows(database.pool, homeId)).length, 2);

        const eventIds = (
          await database.pool.query<{ event_id: string }>(
            `SELECT event_id FROM outbox_events
             WHERE home_id = $1 AND event_type LIKE 'maintenance%'
             ORDER BY created_at ASC`,
            [homeId],
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
        assert.equal((await activityRows(database.pool, homeId)).length, 2);
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
    'leaves processed_at null on Activity insert failure and succeeds on retry',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const create = createCreateMaintenanceEntryFromPool(database.pool);
      const realActivity = createActivityRepository(database.pool);
      const userId = randomUUID();
      const homeId = createUuidV7();
      const membershipId = createUuidV7();
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
        await create({
          actor: actor({
            userId,
            membershipId,
            homeId,
            role: 'ADMIN',
          }),
          homeId,
          visibility: 'HOUSEHOLD',
          title: TITLE_SENTINEL,
        });
        const pending = await pendingMaintenanceEventIds(database.pool, homeId);
        assert.equal(pending.length, 1);
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

  void it(
    'rolls back Activity when a second handler fails and retries idempotently',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const create = createCreateMaintenanceEntryFromPool(database.pool);
      const userId = randomUUID();
      const homeId = createUuidV7();
      const membershipId = createUuidV7();
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
        await create({
          actor: actor({
            userId,
            membershipId,
            homeId,
            role: 'ADMIN',
          }),
          homeId,
          visibility: 'HOUSEHOLD',
          title: TITLE_SENTINEL,
        });
        const pending = await pendingMaintenanceEventIds(database.pool, homeId);
        const eventId = pending[0];
        assert.ok(eventId);

        const secondHandler: OutboxEventHandler = Object.freeze({
          handlerId: 'synthetic_sink',
          eventTypes: [MAINTENANCE_CREATED_V1, MAINTENANCE_RESOLVED_V1],
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
    'handles missing source, Home mismatch, and impossible resolve state',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const create = createCreateMaintenanceEntryFromPool(database.pool);
      const userId = randomUUID();
      const homeA = createUuidV7();
      const homeB = createUuidV7();
      const membershipId = createUuidV7();

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
        const created = await create({
          actor: admin,
          homeId: homeA,
          visibility: 'HOUSEHOLD',
          title: TITLE_SENTINEL,
        });
        const createdEventId = (
          await pendingMaintenanceEventIds(database.pool, homeA)
        )[0];
        assert.ok(createdEventId);

        await database.pool.query(
          'DELETE FROM maintenance_audiences WHERE maintenance_entry_id = $1',
          [created.id],
        );
        await database.pool.query(
          'DELETE FROM maintenance_entries WHERE id = $1',
          [created.id],
        );
        const missingDrain = await drainActivity(database.pool);
        assert.equal(missingDrain.result.failedCount, 0);
        assert.equal(missingDrain.result.processedCount, 1);
        assert.ok(await outboxProcessedAt(database.pool, createdEventId));
        assert.equal((await activityRows(database.pool, homeA)).length, 0);

        const open = await create({
          actor: admin,
          homeId: homeA,
          visibility: 'HOUSEHOLD',
          title: TITLE_SENTINEL,
        });
        await drainActivity(database.pool);

        const mismatchId = createUuidV7();
        await insertOutboxEvent(database.pool, {
          eventId: mismatchId,
          eventType: MAINTENANCE_CREATED_V1,
          homeId: homeB,
          maintenanceEntryId: open.id,
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
        const beforeImpossible = (await activityRows(database.pool, homeA))
          .length;
        assert.equal(
          mismatchLogs.events.some(
            (entry) =>
              entry.fields?.errorClass ===
              new ActivityProjectionIntegrityError().name,
          ),
          true,
        );
        assert.equal(mismatchLogs.serialized().includes(TITLE_SENTINEL), false);

        const impossibleId = createUuidV7();
        await insertOutboxEvent(database.pool, {
          eventId: impossibleId,
          eventType: MAINTENANCE_RESOLVED_V1,
          homeId: homeA,
          maintenanceEntryId: open.id,
        });
        const impossibleDrain = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([
            createActivityOutboxHandlerFromPool(database.pool),
          ]),
          retryPolicy: ZERO_BACKOFF,
        });
        const impossibleResult = await impossibleDrain.drain({ batchSize: 1 });
        assert.equal(impossibleResult.failedCount, 1);
        assert.equal(
          await outboxProcessedAt(database.pool, impossibleId),
          null,
        );
        assert.equal(
          (await activityRows(database.pool, homeA)).length,
          beforeImpossible,
        );

        const stillOpen = await create({
          actor: admin,
          homeId: homeA,
          visibility: 'HOUSEHOLD',
          title: TITLE_SENTINEL,
        });
        const resolveCmd = createResolveMaintenanceEntryFromPool(database.pool);
        await resolveCmd({
          actor: admin,
          homeId: homeA,
          maintenanceEntryId: stillOpen.id,
        });
        await drainActivity(database.pool);
        const forResolved = (await activityRows(database.pool, homeA)).filter(
          (row) =>
            row.source_entity_id === stillOpen.id &&
            row.event_type === MAINTENANCE_CREATED_V1,
        );
        assert.equal(forResolved.length, 1);
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
    'runs Maintenance Activity under handlerId activity after successful projection',
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
      await database.close();
    },
  );
});
