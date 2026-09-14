import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createArchiveFinalMemberHomeFromPool } from '../home-administration/archive-final-member-home.js';
import { createChangeMembershipRoleFromPool } from '../home-administration/change-membership-role.js';
import { createLeaveMembershipFromPool } from '../home-administration/leave-membership.js';
import { createRemoveMembershipFromPool } from '../home-administration/remove-membership.js';
import { createCreateHomeFromPool } from '../homes/create-home.js';
import { createAcceptInvitationFromPool } from '../invitations/accept-invitation.js';
import { createCreateMaintenanceEntryFromPool } from '../maintenance/create-maintenance-entry.js';
import { ActivityPersistenceError } from '../../domains/activity/errors.js';
import { createActivityRepository } from '../../domains/activity/repository.js';
import {
  MAINTENANCE_CREATED_V1,
  MAINTENANCE_RESOLVED_V1,
} from '../../domains/maintenance/events.js';
import {
  MEMBERSHIP_ENDED_V1,
  MEMBERSHIP_ROLE_CHANGED_V1,
  MEMBERSHIP_STARTED_V1,
} from '../../domains/memberships/events.js';
import { SUPPLY_OBTAINED_V1 } from '../../domains/supplies/events.js';
import { TASK_COMPLETED_V1 } from '../../domains/tasks/events.js';
import {
  generateInvitationSecret,
  hashInvitationSecretBytes,
} from '../../domains/invitations/secret.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import type { AppConfig } from '../../platform/config/types.js';
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
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
import { ActivityProjectionIntegrityError } from './errors.js';
import {
  ACTIVITY_OUTBOX_HANDLER_ID,
  createActivityOutboxHandlerFromPool,
} from './outbox-handler.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const TITLE_SENTINEL = 'SENTINEL_MEMBERSHIP_ACTIVITY_TITLE_LEAK_M64B';
const ZERO_BACKOFF: OutboxRetryPolicy = Object.freeze({
  maxAttempts: 8,
  backoffMs: () => 0,
});
const FIXED_AT = new Date('2026-09-13T18:00:00.000Z');

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
    joinedAt?: Date;
    endedAt?: Date | null;
    endedByMembershipId?: string | null;
  },
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
      input.joinedAt ?? FIXED_AT,
      input.endedAt ?? null,
      input.endedByMembershipId ?? null,
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
    await pool.query('DELETE FROM invitations WHERE home_id = ANY($1)', [
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
    await pool.query('DELETE FROM auth_identities WHERE id = ANY($1::uuid[])', [
      input.userIds,
    ]);
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

async function insertOutboxEvent(
  pool: Pool,
  input: {
    eventId: string;
    eventType: string;
    homeId: string;
    payload: object;
    occurredAt?: Date;
  },
): Promise<void> {
  const occurredAt = input.occurredAt ?? FIXED_AT;
  await pool.query(
    `INSERT INTO outbox_events (
       event_id, event_type, occurred_at, available_at, home_id, payload
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      input.eventId,
      input.eventType,
      occurredAt,
      new Date('2026-01-01T00:00:00.000Z'),
      input.homeId,
      JSON.stringify(input.payload),
    ],
  );
}

void describe('Membership Activity projection PostgreSQL', () => {
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
    'projects HOME_VISIBLE structural Membership Activity with exact historical tenure',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const createHome = createCreateHomeFromPool(database.pool);
      const accept = createAcceptInvitationFromPool(database.pool);
      const leave = createLeaveMembershipFromPool(database.pool);
      const remove = createRemoveMembershipFromPool(database.pool);
      const changeRole = createChangeMembershipRoleFromPool(database.pool);
      const createMaintenance = createCreateMaintenanceEntryFromPool(
        database.pool,
      );
      const activities = createActivityRepository(database.pool);
      const userTaylor = randomUUID();
      const userAlex = randomUUID();
      const userJamie = randomUUID();
      const userOther = randomUUID();
      const homeB = createUuidV7();
      const otherHomeMembership = createUuidV7();
      const homeIds: string[] = [homeB];
      const email = `alex-${randomUUID()}@example.com`;
      const secret = generateInvitationSecret();
      const invitationId = createUuidV7();

      try {
        await insertUser(database.pool, userTaylor);
        await insertUser(database.pool, userJamie);
        await insertUser(database.pool, userOther);
        await database.pool.query(
          `INSERT INTO auth_identities (id, name, email, email_verified)
           VALUES ($1, 'Alex', $2, true)`,
          [userAlex, email],
        );

        const created = await createHome({
          userId: userTaylor,
          name: 'Membership Activity Home',
          timezone: 'UTC',
        });
        const homeA = created.home.id;
        homeIds.push(homeA);
        const taylor = created.membership.id;
        await insertHome(database.pool, { id: homeB, name: 'Other Home' });
        await insertMembership(database.pool, {
          id: otherHomeMembership,
          homeId: homeB,
          userId: userOther,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: createUuidV7(),
          homeId: homeA,
          userId: userJamie,
          role: 'ROOMMATE',
        });
        const jamieRow = await database.pool.query<{ id: string }>(
          `SELECT id FROM memberships
           WHERE home_id = $1 AND user_id = $2 AND ended_at IS NULL`,
          [homeA, userJamie],
        );
        const jamie = jamieRow.rows[0]?.id;
        assert.ok(jamie);

        await database.pool.query(
          `INSERT INTO invitations (
             id, home_id, invited_email, token_hash, created_by_membership_id,
             created_at, expires_at
           ) VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute',
                     now() + interval '1 hour')`,
          [
            invitationId,
            homeA,
            email,
            Buffer.from(hashInvitationSecretBytes(secret.bytes)),
            taylor,
          ],
        );
        const accepted = await accept({
          invitationId,
          userId: userAlex,
          secret: secret.encoded,
        });
        const alexA = accepted.membershipId;

        await changeRole({
          actor: actor({
            userId: userTaylor,
            membershipId: taylor,
            homeId: homeA,
            role: 'ADMIN',
          }),
          homeId: homeA,
          membershipId: alexA,
          role: 'ADMIN',
        });
        await changeRole({
          actor: actor({
            userId: userTaylor,
            membershipId: taylor,
            homeId: homeA,
            role: 'ADMIN',
          }),
          homeId: homeA,
          membershipId: alexA,
          role: 'ROOMMATE',
        });

        const privateMaint = await createMaintenance({
          actor: actor({
            userId: userJamie,
            membershipId: jamie,
            homeId: homeA,
            role: 'ROOMMATE',
          }),
          homeId: homeA,
          visibility: 'PRIVATE',
          title: TITLE_SENTINEL,
          audienceMembershipIds: [],
        });

        const logs = capturingLogger();
        const drained = await drainActivity(database.pool, [], logs);
        assert.equal(drained.result.failedCount, 0);

        const rows = await activityRows(database.pool, homeA);
        const startedTaylor = rows.find(
          (row) =>
            row.event_type === MEMBERSHIP_STARTED_V1 &&
            row.source_entity_id === taylor,
        );
        const startedAlex = rows.find(
          (row) =>
            row.event_type === MEMBERSHIP_STARTED_V1 &&
            row.source_entity_id === alexA,
        );
        const roleRows = rows.filter(
          (row) => row.event_type === MEMBERSHIP_ROLE_CHANGED_V1,
        );
        const privateActivity = rows.find(
          (row) =>
            row.source_entity_id === privateMaint.id &&
            row.event_type === MAINTENANCE_CREATED_V1,
        );
        assert.ok(startedTaylor);
        assert.ok(startedAlex);
        assert.equal(startedTaylor.visibility_class, 'HOME_VISIBLE');
        assert.equal(startedTaylor.source_entity_type, 'MEMBERSHIP');
        assert.equal(startedTaylor.actor_membership_id, taylor);
        assert.deepEqual(
          await recipientIds(database.pool, startedTaylor.id),
          [],
        );
        assert.equal(startedAlex.actor_membership_id, alexA);
        assert.equal(startedAlex.source_entity_id, alexA);
        assert.deepEqual(await recipientIds(database.pool, startedAlex.id), []);
        assert.equal(roleRows.length, 2);
        for (const row of roleRows) {
          assert.equal(row.visibility_class, 'HOME_VISIBLE');
          assert.equal(row.source_entity_id, alexA);
          assert.equal(row.actor_membership_id, taylor);
          assert.notEqual(row.actor_membership_id, alexA);
          assert.deepEqual(await recipientIds(database.pool, row.id), []);
        }
        assert.ok(privateActivity);

        const taylorVisible = await activities.listVisibleByHome(homeA, taylor);
        const jamieVisible = await activities.listVisibleByHome(homeA, jamie);
        const alexVisible = await activities.listVisibleByHome(homeA, alexA);
        assert.ok(taylorVisible);
        assert.ok(jamieVisible);
        assert.ok(alexVisible);
        assert.equal(
          taylorVisible.some((item) => item.id === startedAlex.id),
          true,
        );
        assert.equal(
          jamieVisible.some((item) => item.id === startedAlex.id),
          true,
        );
        assert.equal(
          alexVisible.some((item) => item.id === startedTaylor.id),
          true,
        );
        assert.equal(
          taylorVisible.some((item) => item.id === privateActivity.id),
          false,
        );
        assert.equal(
          await activities.listVisibleByHome(homeA, otherHomeMembership),
          null,
        );

        await leave({
          actor: actor({
            userId: userAlex,
            membershipId: alexA,
            homeId: homeA,
            role: 'ROOMMATE',
          }),
          homeId: homeA,
          membershipId: alexA,
        });
        const afterLeave = await drainActivity(database.pool);
        assert.equal(afterLeave.result.failedCount, 0);
        const leaveActivity = (await activityRows(database.pool, homeA)).find(
          (row) =>
            row.event_type === MEMBERSHIP_ENDED_V1 &&
            row.source_entity_id === alexA,
        );
        assert.ok(leaveActivity);
        assert.equal(leaveActivity.actor_membership_id, alexA);
        assert.deepEqual(
          await recipientIds(database.pool, leaveActivity.id),
          [],
        );
        assert.equal(await activities.listVisibleByHome(homeA, alexA), null);

        const rejoinSecret = generateInvitationSecret();
        const rejoinInvitationId = createUuidV7();
        await database.pool.query(
          `INSERT INTO invitations (
             id, home_id, invited_email, token_hash, created_by_membership_id,
             created_at, expires_at
           ) VALUES ($1, $2, $3, $4, $5, now(), now() + interval '1 hour')`,
          [
            rejoinInvitationId,
            homeA,
            email,
            Buffer.from(hashInvitationSecretBytes(rejoinSecret.bytes)),
            taylor,
          ],
        );
        const rejoined = await accept({
          invitationId: rejoinInvitationId,
          userId: userAlex,
          secret: rejoinSecret.encoded,
        });
        const alexB = rejoined.membershipId;
        assert.notEqual(alexB, alexA);
        const afterRejoin = await drainActivity(database.pool);
        assert.equal(afterRejoin.result.failedCount, 0);
        const startedB = (await activityRows(database.pool, homeA)).find(
          (row) =>
            row.event_type === MEMBERSHIP_STARTED_V1 &&
            row.source_entity_id === alexB,
        );
        assert.ok(startedB);
        assert.equal(startedB.actor_membership_id, alexB);
        const historical = await activityRows(database.pool, homeA);
        const leaveAfter = historical.find(
          (row) => row.id === leaveActivity.id,
        );
        const startedAAfter = historical.find(
          (row) => row.id === startedAlex.id,
        );
        assert.equal(leaveAfter?.source_entity_id, alexA);
        assert.equal(leaveAfter?.actor_membership_id, alexA);
        assert.equal(startedAAfter?.source_entity_id, alexA);
        assert.notEqual(startedAAfter?.source_entity_id, alexB);
        const alexBVisible = await activities.listVisibleByHome(homeA, alexB);
        assert.ok(alexBVisible);
        assert.equal(
          alexBVisible.some((item) => item.id === leaveActivity.id),
          true,
        );
        assert.equal(
          alexBVisible.some((item) => item.id === startedAlex.id),
          true,
        );

        await remove({
          actor: actor({
            userId: userTaylor,
            membershipId: taylor,
            homeId: homeA,
            role: 'ADMIN',
          }),
          homeId: homeA,
          membershipId: jamie,
        });
        const afterRemove = await drainActivity(database.pool);
        assert.equal(afterRemove.result.failedCount, 0);
        const removeActivity = (await activityRows(database.pool, homeA)).find(
          (row) =>
            row.event_type === MEMBERSHIP_ENDED_V1 &&
            row.source_entity_id === jamie,
        );
        assert.ok(removeActivity);
        assert.equal(removeActivity.actor_membership_id, taylor);
        assert.notEqual(removeActivity.actor_membership_id, jamie);
        assert.equal(removeActivity.source_entity_id, jamie);

        assert.equal(logs.serialized().includes(TITLE_SENTINEL), false);
        assert.equal(logs.serialized().includes(email), false);
      } finally {
        await cleanup(database.pool, {
          homeIds,
          userIds: [userTaylor, userAlex, userJamie, userOther],
        });
        await database.close();
      }
    },
  );

  void it(
    'is idempotent, no-ops missing sources, and fails closed on integrity',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userId = randomUUID();
      const subjectUser = randomUUID();
      const laterActorUser = randomUUID();
      const homeA = createUuidV7();
      const homeB = createUuidV7();
      const membershipId = createUuidV7();
      const actorId = createUuidV7();
      const laterActorId = createUuidV7();
      const transitionId = createUuidV7();
      const laterTransitionId = createUuidV7();

      try {
        await insertUser(database.pool, userId);
        await insertUser(database.pool, subjectUser);
        await insertUser(database.pool, laterActorUser);
        await insertHome(database.pool, { id: homeA, name: 'Integrity A' });
        await insertHome(database.pool, { id: homeB, name: 'Integrity B' });
        await insertMembership(database.pool, {
          id: actorId,
          homeId: homeA,
          userId,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: laterActorId,
          homeId: homeA,
          userId: laterActorUser,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipId,
          homeId: homeA,
          userId: subjectUser,
          role: 'ROOMMATE',
          joinedAt: FIXED_AT,
        });

        const missingStartedId = createUuidV7();
        await insertOutboxEvent(database.pool, {
          eventId: missingStartedId,
          eventType: MEMBERSHIP_STARTED_V1,
          homeId: homeA,
          payload: { membershipId: createUuidV7() },
        });
        const missingStarted = await drainActivity(database.pool);
        assert.equal(missingStarted.result.failedCount, 0);
        assert.ok(await outboxProcessedAt(database.pool, missingStartedId));
        assert.equal((await activityRows(database.pool, homeA)).length, 0);

        const missingEndedId = createUuidV7();
        await insertOutboxEvent(database.pool, {
          eventId: missingEndedId,
          eventType: MEMBERSHIP_ENDED_V1,
          homeId: homeA,
          payload: { membershipId: createUuidV7() },
        });
        const missingEnded = await drainActivity(database.pool);
        assert.equal(missingEnded.result.failedCount, 0);
        assert.ok(await outboxProcessedAt(database.pool, missingEndedId));

        const missingTransitionId = createUuidV7();
        await insertOutboxEvent(database.pool, {
          eventId: missingTransitionId,
          eventType: MEMBERSHIP_ROLE_CHANGED_V1,
          homeId: homeA,
          payload: {
            membershipId,
            roleTransitionId: createUuidV7(),
          },
        });
        const missingTransition = await drainActivity(database.pool);
        assert.equal(missingTransition.result.failedCount, 0);
        assert.ok(await outboxProcessedAt(database.pool, missingTransitionId));

        const startedMismatchId = createUuidV7();
        await insertOutboxEvent(database.pool, {
          eventId: startedMismatchId,
          eventType: MEMBERSHIP_STARTED_V1,
          homeId: homeB,
          payload: { membershipId },
        });
        const startedMismatchLogs = capturingLogger();
        const startedMismatch = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([
            createActivityOutboxHandlerFromPool(database.pool),
          ]),
          logger: startedMismatchLogs.logger,
          retryPolicy: ZERO_BACKOFF,
        });
        assert.equal(
          (await startedMismatch.drain({ batchSize: 1 })).failedCount,
          1,
        );
        assert.equal(
          await outboxProcessedAt(database.pool, startedMismatchId),
          null,
        );
        assert.equal(
          startedMismatchLogs.events.some(
            (entry) =>
              entry.fields?.errorClass ===
              new ActivityProjectionIntegrityError().name,
          ),
          true,
        );

        const endedMismatchId = createUuidV7();
        await insertOutboxEvent(database.pool, {
          eventId: endedMismatchId,
          eventType: MEMBERSHIP_ENDED_V1,
          homeId: homeB,
          payload: { membershipId },
        });
        const endedMismatch = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([
            createActivityOutboxHandlerFromPool(database.pool),
          ]),
          retryPolicy: ZERO_BACKOFF,
        });
        assert.equal(
          (await endedMismatch.drain({ batchSize: 1 })).failedCount,
          1,
        );

        const nullAttributionId = createUuidV7();
        await insertOutboxEvent(database.pool, {
          eventId: nullAttributionId,
          eventType: MEMBERSHIP_ENDED_V1,
          homeId: homeA,
          payload: { membershipId },
        });
        const nullAttribution = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([
            createActivityOutboxHandlerFromPool(database.pool),
          ]),
          retryPolicy: ZERO_BACKOFF,
        });
        assert.equal(
          (await nullAttribution.drain({ batchSize: 1 })).failedCount,
          1,
        );
        assert.equal(
          await outboxProcessedAt(database.pool, nullAttributionId),
          null,
        );

        await database.pool.query(
          `INSERT INTO membership_role_transitions (
             id, home_id, membership_id, actor_membership_id, changed_at, created_at
           ) VALUES ($1, $2, $3, $4, $5, $5)`,
          [transitionId, homeA, membershipId, actorId, FIXED_AT],
        );
        const wrongSubjectId = createUuidV7();
        await insertOutboxEvent(database.pool, {
          eventId: wrongSubjectId,
          eventType: MEMBERSHIP_ROLE_CHANGED_V1,
          homeId: homeA,
          payload: {
            membershipId: actorId,
            roleTransitionId: transitionId,
          },
        });
        const wrongSubject = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([
            createActivityOutboxHandlerFromPool(database.pool),
          ]),
          retryPolicy: ZERO_BACKOFF,
        });
        assert.equal(
          (await wrongSubject.drain({ batchSize: 1 })).failedCount,
          1,
        );
        assert.equal(
          await outboxProcessedAt(database.pool, wrongSubjectId),
          null,
        );

        await database.pool.query(
          `INSERT INTO membership_role_transitions (
             id, home_id, membership_id, actor_membership_id, changed_at, created_at
           ) VALUES ($1, $2, $3, $4, $5, $5)`,
          [laterTransitionId, homeA, membershipId, laterActorId, FIXED_AT],
        );
        const firstQueuedId = createUuidV7();
        const secondQueuedId = createUuidV7();
        await insertOutboxEvent(database.pool, {
          eventId: firstQueuedId,
          eventType: MEMBERSHIP_ROLE_CHANGED_V1,
          homeId: homeA,
          payload: {
            membershipId,
            roleTransitionId: transitionId,
          },
        });
        await insertOutboxEvent(database.pool, {
          eventId: secondQueuedId,
          eventType: MEMBERSHIP_ROLE_CHANGED_V1,
          homeId: homeA,
          payload: {
            membershipId,
            roleTransitionId: laterTransitionId,
          },
        });
        await database.pool.query(
          `UPDATE memberships SET role = 'ADMIN' WHERE id = $1`,
          [membershipId],
        );
        await database.pool.query(
          `DELETE FROM outbox_events
           WHERE processed_at IS NULL
             AND event_id <> $1
             AND event_id <> $2`,
          [firstQueuedId, secondQueuedId],
        );
        const queued = await drainActivity(database.pool);
        assert.equal(queued.result.failedCount, 0);
        const roleActivities = (
          await activityRows(database.pool, homeA)
        ).filter((row) => row.event_type === MEMBERSHIP_ROLE_CHANGED_V1);
        assert.equal(roleActivities.length, 2);
        const firstProjected = roleActivities.find(
          (row) => row.source_outbox_event_id === firstQueuedId,
        );
        const secondProjected = roleActivities.find(
          (row) => row.source_outbox_event_id === secondQueuedId,
        );
        assert.ok(firstProjected);
        assert.ok(secondProjected);
        assert.equal(firstProjected.actor_membership_id, actorId);
        assert.equal(secondProjected.actor_membership_id, laterActorId);
        assert.notEqual(
          firstProjected.actor_membership_id,
          secondProjected.actor_membership_id,
        );
        assert.equal(firstProjected.source_entity_id, membershipId);
        assert.notEqual(firstProjected.id, secondProjected.id);

        await insertOutboxEvent(database.pool, {
          eventId: createUuidV7(),
          eventType: MEMBERSHIP_STARTED_V1,
          homeId: homeA,
          payload: { membershipId },
        });
        await database.pool.query(
          `UPDATE memberships
           SET ended_at = $2, ended_by_membership_id = $1
           WHERE id = $1`,
          [membershipId, new Date('2026-09-14T00:00:00.000Z')],
        );
        const endedBeforeConsume = await drainActivity(database.pool);
        assert.equal(endedBeforeConsume.result.failedCount, 0);
        const startedWhileEnded = (
          await activityRows(database.pool, homeA)
        ).find(
          (row) =>
            row.event_type === MEMBERSHIP_STARTED_V1 &&
            row.source_entity_id === membershipId,
        );
        assert.ok(startedWhileEnded);
        assert.equal(startedWhileEnded.actor_membership_id, membershipId);

        const replayIds = (
          await database.pool.query<{ event_id: string }>(
            `SELECT event_id FROM outbox_events
             WHERE home_id = $1 AND event_type = $2 AND processed_at IS NOT NULL`,
            [homeA, MEMBERSHIP_STARTED_V1],
          )
        ).rows.map((row) => row.event_id);
        await database.pool.query(
          `UPDATE outbox_events SET processed_at = NULL, dead_at = NULL,
                  lease_owner = NULL, leased_at = NULL, lease_until = NULL
           WHERE event_id = ANY($1::uuid[])`,
          [replayIds],
        );
        const beforeReplay = (await activityRows(database.pool, homeA)).filter(
          (row) => row.event_type === MEMBERSHIP_STARTED_V1,
        ).length;
        const replay = await drainActivity(database.pool);
        assert.equal(replay.result.failedCount, 0);
        assert.equal(
          (await activityRows(database.pool, homeA)).filter(
            (row) => row.event_type === MEMBERSHIP_STARTED_V1,
          ).length,
          beforeReplay,
        );
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeA, homeB],
          userIds: [userId, subjectUser, laterActorUser],
        });
        await database.close();
      }
    },
  );

  void it(
    'projects final-archive ended Activity but hides it from archived Home reads',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const createHome = createCreateHomeFromPool(database.pool);
      const archive = createArchiveFinalMemberHomeFromPool(database.pool);
      const activities = createActivityRepository(database.pool);
      const userId = randomUUID();
      const homeIds: string[] = [];

      try {
        await insertUser(database.pool, userId);
        const created = await createHome({
          userId,
          name: 'Archive Activity Home',
          timezone: 'UTC',
        });
        homeIds.push(created.home.id);
        await archive({
          homeId: created.home.id,
          actor: actor({
            userId,
            membershipId: created.membership.id,
            homeId: created.home.id,
            role: 'ADMIN',
          }),
        });
        const drained = await drainActivity(database.pool);
        assert.equal(drained.result.failedCount, 0);
        const rows = await activityRows(database.pool, created.home.id);
        const ended = rows.find(
          (row) =>
            row.event_type === MEMBERSHIP_ENDED_V1 &&
            row.source_entity_id === created.membership.id,
        );
        assert.ok(ended);
        assert.equal(ended.actor_membership_id, created.membership.id);
        assert.equal(
          await activities.listVisibleByHome(
            created.home.id,
            created.membership.id,
          ),
          null,
        );
      } finally {
        await cleanup(database.pool, {
          homeIds,
          userIds: [userId],
        });
        await database.close();
      }
    },
  );

  void it(
    'registers seven exact event types and rolls back Membership Activity on later handler failure',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const createHome = createCreateHomeFromPool(database.pool);
      const userId = randomUUID();
      let failSecond = true;

      try {
        const handler = createActivityOutboxHandlerFromPool(database.pool);
        assert.equal(handler.handlerId, ACTIVITY_OUTBOX_HANDLER_ID);
        assert.deepEqual(handler.eventTypes, [
          MAINTENANCE_CREATED_V1,
          MAINTENANCE_RESOLVED_V1,
          TASK_COMPLETED_V1,
          SUPPLY_OBTAINED_V1,
          MEMBERSHIP_STARTED_V1,
          MEMBERSHIP_ENDED_V1,
          MEMBERSHIP_ROLE_CHANGED_V1,
        ]);

        await insertUser(database.pool, userId);
        const created = await createHome({
          userId,
          name: 'Dispatcher Membership Home',
          timezone: 'UTC',
        });
        const pending = await database.pool.query<{ event_id: string }>(
          `SELECT event_id FROM outbox_events
           WHERE home_id = $1 AND event_type = $2 AND processed_at IS NULL`,
          [created.home.id, MEMBERSHIP_STARTED_V1],
        );
        const eventId = pending.rows[0]?.event_id;
        assert.ok(eventId);

        const secondHandler: OutboxEventHandler = Object.freeze({
          handlerId: 'synthetic_sink',
          eventTypes: [MEMBERSHIP_STARTED_V1],
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
        assert.equal((await first.drain({ batchSize: 1 })).failedCount, 1);
        assert.equal(await outboxProcessedAt(database.pool, eventId), null);
        assert.equal(
          (await activityRows(database.pool, created.home.id)).length,
          0,
        );

        failSecond = false;
        const second = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([
            createActivityOutboxHandlerFromPool(database.pool),
            secondHandler,
          ]),
          retryPolicy: ZERO_BACKOFF,
        });
        assert.equal((await second.drain({ batchSize: 1 })).failedCount, 0);
        assert.ok(await outboxProcessedAt(database.pool, eventId));
        assert.equal(
          (await activityRows(database.pool, created.home.id)).length,
          1,
        );

        await database.pool.query(
          `UPDATE outbox_events SET processed_at = NULL, dead_at = NULL,
                  lease_owner = NULL, leased_at = NULL, lease_until = NULL
           WHERE event_id = $1`,
          [eventId],
        );
        assert.equal((await second.drain({ batchSize: 1 })).failedCount, 0);
        assert.equal(
          (await activityRows(database.pool, created.home.id)).length,
          1,
        );
      } finally {
        const homes = await database.pool.query<{ id: string }>(
          `SELECT id FROM homes WHERE name = 'Dispatcher Membership Home'`,
        );
        await cleanup(database.pool, {
          homeIds: homes.rows.map((row) => row.id),
          userIds: [userId],
        });
        await database.close();
      }
    },
  );

  void it(
    'leaves processed_at null on Membership Activity insert failure and succeeds on retry',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const createHome = createCreateHomeFromPool(database.pool);
      const userId = randomUUID();
      let failInsert = true;

      try {
        await insertUser(database.pool, userId);
        const created = await createHome({
          userId,
          name: 'Retry Membership Home',
          timezone: 'UTC',
        });
        const pending = await database.pool.query<{ event_id: string }>(
          `SELECT event_id FROM outbox_events
           WHERE home_id = $1 AND event_type = $2 AND processed_at IS NULL`,
          [created.home.id, MEMBERSHIP_STARTED_V1],
        );
        const eventId = pending.rows[0]?.event_id;
        assert.ok(eventId);

        const consumer = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([
            {
              handlerId: ACTIVITY_OUTBOX_HANDLER_ID,
              eventTypes: [
                MEMBERSHIP_STARTED_V1,
                MEMBERSHIP_ENDED_V1,
                MEMBERSHIP_ROLE_CHANGED_V1,
                MAINTENANCE_CREATED_V1,
                MAINTENANCE_RESOLVED_V1,
                TASK_COMPLETED_V1,
                SUPPLY_OBTAINED_V1,
              ],
              async handle(tx, event) {
                const live = createActivityOutboxHandlerFromPool(database.pool);
                if (failInsert && event.eventType === MEMBERSHIP_STARTED_V1) {
                  throw new ActivityPersistenceError();
                }
                await live.handle(tx, event);
              },
            },
          ]),
          retryPolicy: ZERO_BACKOFF,
        });
        assert.equal((await consumer.drain({ batchSize: 1 })).failedCount, 1);
        assert.equal(await outboxProcessedAt(database.pool, eventId), null);
        assert.equal(
          (await activityRows(database.pool, created.home.id)).length,
          0,
        );

        failInsert = false;
        assert.equal((await consumer.drain({ batchSize: 1 })).failedCount, 0);
        assert.ok(await outboxProcessedAt(database.pool, eventId));
        assert.equal(
          (await activityRows(database.pool, created.home.id)).length,
          1,
        );
      } finally {
        const homes = await database.pool.query<{ id: string }>(
          `SELECT id FROM homes WHERE name = 'Retry Membership Home'`,
        );
        await cleanup(database.pool, {
          homeIds: homes.rows.map((row) => row.id),
          userIds: [userId],
        });
        await database.close();
      }
    },
  );
});
