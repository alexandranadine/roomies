import { Temporal } from '@js-temporal/polyfill';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createChangeMembershipRoleFromPool } from '../home-administration/change-membership-role.js';
import { createLeaveMembershipFromPool } from '../home-administration/leave-membership.js';
import { lockHomeAndExactMemberships } from '../../domains/homes/lock-home-and-exact-memberships.js';
import { computeInitialRecurrenceCursor } from '../../domains/tasks/recurrence-cursor.js';
import { createTaskRepository } from '../../domains/tasks/repository.js';
import { toTaskDefinitionDto } from '../../domains/tasks/task-definition-dto.js';
import { TaskDefinitionAlreadyDeactivatedError } from '../../domains/tasks/errors.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  InvalidRequestError,
} from '../../platform/authz/errors.js';
import type { AppConfig } from '../../platform/config/types.js';
import { createUuidV7, systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import { createCreateRecurringTaskDefinition } from './create-recurring-task-definition.js';
import { createDeactivateTaskDefinition } from './deactivate-task-definition.js';
import { createListHomeTaskDefinitionsFromPool } from './list-home-task-definitions.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const OCCURRED = new Date('2026-09-12T18:00:00.000Z');
const DEACTIVATED = new Date('2026-09-13T18:00:00.000Z');
const APIA_CREATED = new Date('2011-12-29T10:00:00.001Z');

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
  input: { id: string; name: string; timezone?: string; archived?: boolean },
): Promise<void> {
  await pool.query(
    `INSERT INTO homes (id, name, timezone, archived_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [
      input.id,
      input.name,
      input.timezone ?? 'UTC',
      input.archived === true ? new Date() : null,
    ],
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
    `INSERT INTO memberships (id, home_id, user_id, role, ended_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      input.id,
      input.homeId,
      input.userId,
      input.role,
      input.ended === true ? new Date() : null,
    ],
  );
}

async function cleanup(
  pool: Pool,
  input: { userIds: string[]; homeIds: string[] },
): Promise<void> {
  if (input.homeIds.length > 0) {
    await pool.query('DELETE FROM task_instances WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query('DELETE FROM task_definitions WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query('DELETE FROM outbox_events WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query('DELETE FROM memberships WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query('DELETE FROM homes WHERE id = ANY($1)', [input.homeIds]);
  }
  if (input.userIds.length > 0) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [input.userIds]);
  }
}

function roommate(
  homeId: string,
  membershipId: string,
  userId: string,
): ActiveHomeActor {
  return { userId, membershipId, homeId, role: 'ROOMMATE' };
}

function admin(
  homeId: string,
  membershipId: string,
  userId: string,
): ActiveHomeActor {
  return { userId, membershipId, homeId, role: 'ADMIN' };
}

void describe('recurring TaskDefinitions PostgreSQL', () => {
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
    'creates, lists, and deactivates definitions with exact cursor lifecycle',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const tasks = createTaskRepository(database.pool);
      const create = createCreateRecurringTaskDefinition({
        runTransaction: (work) =>
          runInReadCommittedTransaction(database.pool, work),
        lockHomeAndExactMemberships,
        tasks,
        clock: { now: () => OCCURRED },
        ids: systemUuidV7,
      });
      const deactivate = createDeactivateTaskDefinition({
        runTransaction: (work) =>
          runInReadCommittedTransaction(database.pool, work),
        lockHomeAndExactMemberships,
        tasks,
        clock: { now: () => DEACTIVATED },
      });
      const list = createListHomeTaskDefinitionsFromPool(database.pool);

      const userA = randomUUID();
      const userB = randomUUID();
      const userC = randomUUID();
      const homeA = createUuidV7();
      const homeB = createUuidV7();
      const archivedHome = createUuidV7();
      const membershipA = createUuidV7();
      const membershipB = createUuidV7();
      const membershipC = createUuidV7();
      const endedMembership = createUuidV7();
      const otherMembership = createUuidV7();
      const archivedMembership = createUuidV7();
      const userIds = [userA, userB, userC];
      const homeIds = [homeA, homeB, archivedHome];

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertUser(database.pool, userC);
        await insertHome(database.pool, {
          id: homeA,
          name: 'Home A',
          timezone: 'America/Los_Angeles',
        });
        await insertHome(database.pool, { id: homeB, name: 'Home B' });
        await insertHome(database.pool, {
          id: archivedHome,
          name: 'Archived',
          archived: true,
        });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId: homeA,
          userId: userA,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId: homeA,
          userId: userB,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipC,
          homeId: homeA,
          userId: userC,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: endedMembership,
          homeId: homeA,
          userId: userA,
          role: 'ROOMMATE',
          ended: true,
        });
        await insertMembership(database.pool, {
          id: otherMembership,
          homeId: homeB,
          userId: userB,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: archivedMembership,
          homeId: archivedHome,
          userId: userA,
          role: 'ADMIN',
        });

        const actorA = roommate(homeA, membershipA, userA);
        const actorB = admin(homeA, membershipB, userB);
        const actorC = roommate(homeA, membershipC, userC);
        const daily = await create({
          actor: actorA,
          homeId: homeA,
          title: '  Daily dishes  ',
          frequency: 'DAILY',
        });
        const weekly = await create({
          actor: actorA,
          homeId: homeA,
          title: 'Weekly trash',
          frequency: 'WEEKLY',
          weekday: 1,
          assignedMembershipId: membershipC,
        });
        const monthly = await create({
          actor: actorB,
          homeId: homeA,
          title: 'Monthly rent',
          frequency: 'MONTHLY',
          dayOfMonth: 15,
        });
        const selfAssigned = await create({
          actor: actorA,
          homeId: homeA,
          title: 'Self assigned',
          frequency: 'DAILY',
          assignedMembershipId: membershipA,
        });

        const expectedDaily = computeInitialRecurrenceCursor({
          frequency: 'DAILY',
          weekday: null,
          dayOfMonth: null,
          homeTimeZone: 'America/Los_Angeles',
          createdAt: Temporal.Instant.from(OCCURRED.toISOString()),
        });
        assert.equal(daily.title, 'Daily dishes');
        assert.equal(daily.creatorMembershipId, membershipA);
        assert.equal(daily.assignedMembershipId, null);
        assert.equal(daily.deactivatedAt, null);
        assert.equal(daily.nextOccurrenceDate, expectedDaily.occurrenceDate);
        assert.equal(daily.createdAt.toISOString(), OCCURRED.toISOString());
        assert.equal(weekly.weekday, 1);
        assert.equal(weekly.assignedMembershipId, membershipC);
        assert.equal(monthly.dayOfMonth, 15);
        assert.equal(selfAssigned.assignedMembershipId, membershipA);
        assert.equal(selfAssigned.creatorMembershipId, membershipA);

        const dailyRow = await database.pool.query<{
          deactivated_at: Date | null;
          next_occurrence_date: string;
          next_occurrence_at: Date;
          creator_membership_id: string;
        }>(
          `SELECT deactivated_at,
                  next_occurrence_date::text AS next_occurrence_date,
                  next_occurrence_at,
                  creator_membership_id
           FROM task_definitions WHERE id = $1`,
          [daily.id],
        );
        assert.equal(dailyRow.rows[0]?.deactivated_at, null);
        assert.equal(
          dailyRow.rows[0]?.next_occurrence_date,
          expectedDaily.occurrenceDate,
        );
        assert.equal(
          dailyRow.rows[0]?.next_occurrence_at.toISOString(),
          new Date(expectedDaily.occurrenceAt.toString()).toISOString(),
        );
        assert.equal(dailyRow.rows[0]?.creator_membership_id, membershipA);
        assert.equal(
          Temporal.Instant.compare(
            Temporal.Instant.from(
              dailyRow.rows[0]?.next_occurrence_at.toISOString() ?? '',
            ),
            Temporal.Instant.from(OCCURRED.toISOString()),
          ) > 0,
          true,
        );

        const utcCursor = computeInitialRecurrenceCursor({
          frequency: 'DAILY',
          weekday: null,
          dayOfMonth: null,
          homeTimeZone: 'UTC',
          createdAt: Temporal.Instant.from(OCCURRED.toISOString()),
        });
        assert.notEqual(
          dailyRow.rows[0]?.next_occurrence_at.toISOString(),
          new Date(utcCursor.occurrenceAt.toString()).toISOString(),
        );

        await assert.rejects(
          () =>
            create({
              actor: actorA,
              homeId: homeA,
              title: 'Bad daily',
              frequency: 'DAILY',
              weekday: 1,
            }),
          InvalidRequestError,
        );
        await assert.rejects(
          () =>
            create({
              actor: actorA,
              homeId: homeA,
              title: '   ',
              frequency: 'DAILY',
            }),
          InvalidRequestError,
        );
        await assert.rejects(
          () =>
            create({
              actor: actorA,
              homeId: homeA,
              title: 'Ended assignee',
              frequency: 'DAILY',
              assignedMembershipId: endedMembership,
            }),
          InvalidRequestError,
        );
        await assert.rejects(
          () =>
            create({
              actor: actorA,
              homeId: homeA,
              title: 'Cross home',
              frequency: 'DAILY',
              assignedMembershipId: otherMembership,
            }),
          InvalidRequestError,
        );
        await assert.rejects(
          () =>
            create({
              actor: actorA,
              homeId: homeA,
              title: 'Unknown assignee',
              frequency: 'DAILY',
              assignedMembershipId: createUuidV7(),
            }),
          InvalidRequestError,
        );
        await assert.rejects(
          () =>
            create({
              actor: roommate(homeA, endedMembership, userA),
              homeId: homeA,
              title: 'Old tenure',
              frequency: 'DAILY',
            }),
          ConcealedNotFoundError,
        );
        await assert.rejects(
          () =>
            create({
              actor: admin(archivedHome, archivedMembership, userA),
              homeId: archivedHome,
              title: 'Archived',
              frequency: 'DAILY',
            }),
          ConcealedNotFoundError,
        );

        const otherHomeDef = await create({
          actor: roommate(homeB, otherMembership, userB),
          homeId: homeB,
          title: 'Other home',
          frequency: 'DAILY',
        });

        const listed = await list({ actor: actorA, homeId: homeA });
        assert.equal(
          listed.some((row) => row.id === otherHomeDef.id),
          false,
        );
        const dto = toTaskDefinitionDto(listed[0] ?? daily);
        assert.equal('nextOccurrenceAt' in dto, false);
        assert.equal('homeId' in dto, false);
        assert.equal(typeof dto.nextOccurrenceDate, 'string');

        const deactivated = await deactivate({
          actor: actorA,
          homeId: homeA,
          taskDefinitionId: daily.id,
        });
        assert.equal(
          deactivated.deactivatedAt?.toISOString(),
          DEACTIVATED.toISOString(),
        );
        assert.equal(
          deactivated.updatedAt.toISOString(),
          DEACTIVATED.toISOString(),
        );
        assert.equal(deactivated.nextOccurrenceDate, null);
        assert.equal(deactivated.nextOccurrenceAt, null);
        assert.equal(deactivated.frequency, 'DAILY');
        assert.equal(deactivated.creatorMembershipId, membershipA);

        const deactivatedRow = await database.pool.query<{
          deactivated_at: Date;
          next_occurrence_date: string | null;
          next_occurrence_at: Date | null;
          updated_at: Date;
        }>(
          `SELECT deactivated_at,
                  next_occurrence_date::text AS next_occurrence_date,
                  next_occurrence_at,
                  updated_at
           FROM task_definitions WHERE id = $1`,
          [daily.id],
        );
        assert.equal(
          deactivatedRow.rows[0]?.deactivated_at.toISOString(),
          DEACTIVATED.toISOString(),
        );
        assert.equal(deactivatedRow.rows[0]?.next_occurrence_date, null);
        assert.equal(deactivatedRow.rows[0]?.next_occurrence_at, null);

        await assert.rejects(
          () =>
            deactivate({
              actor: actorA,
              homeId: homeA,
              taskDefinitionId: daily.id,
            }),
          TaskDefinitionAlreadyDeactivatedError,
        );
        const second = await database.pool.query<{
          deactivated_at: Date;
          updated_at: Date;
        }>(
          `SELECT deactivated_at, updated_at FROM task_definitions WHERE id = $1`,
          [daily.id],
        );
        assert.equal(
          second.rows[0]?.deactivated_at.toISOString(),
          DEACTIVATED.toISOString(),
        );
        assert.equal(
          second.rows[0]?.updated_at.toISOString(),
          DEACTIVATED.toISOString(),
        );

        await deactivate({
          actor: actorB,
          homeId: homeA,
          taskDefinitionId: weekly.id,
        });
        await assert.rejects(
          () =>
            deactivate({
              actor: actorC,
              homeId: homeA,
              taskDefinitionId: monthly.id,
            }),
          ConcealedNotFoundError,
        );
        await assert.rejects(
          () =>
            deactivate({
              actor: actorC,
              homeId: homeA,
              taskDefinitionId: selfAssigned.id,
            }),
          ConcealedNotFoundError,
        );
        await assert.rejects(
          () =>
            deactivate({
              actor: actorA,
              homeId: homeA,
              taskDefinitionId: otherHomeDef.id,
            }),
          ConcealedNotFoundError,
        );
        await assert.rejects(
          () =>
            deactivate({
              actor: actorA,
              homeId: homeA,
              taskDefinitionId: createUuidV7(),
            }),
          ConcealedNotFoundError,
        );

        const ordered = await list({ actor: actorA, homeId: homeA });
        assert.deepEqual(
          ordered.map((row) => row.id),
          [monthly.id, selfAssigned.id, daily.id, weekly.id],
        );
        assert.equal(ordered[0]?.deactivatedAt, null);
        assert.equal(ordered[2]?.deactivatedAt !== null, true);

        const instances = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM task_instances
           WHERE home_id = ANY($1)`,
          [[homeA, homeB]],
        );
        assert.equal(instances.rows[0]?.count, '0');
        const outbox = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM outbox_events
           WHERE home_id = ANY($1)`,
          [[homeA, homeB]],
        );
        assert.equal(outbox.rows[0]?.count, '0');
      } finally {
        await cleanup(database.pool, { userIds, homeIds });
        await database.close();
      }
    },
  );

  void it(
    'preserves exact creator tenure through rejoin and assignee-end cleanup',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const tasks = createTaskRepository(database.pool);
      const create = createCreateRecurringTaskDefinition({
        runTransaction: (work) =>
          runInReadCommittedTransaction(database.pool, work),
        lockHomeAndExactMemberships,
        tasks,
        clock: { now: () => OCCURRED },
        ids: systemUuidV7,
      });
      const deactivate = createDeactivateTaskDefinition({
        runTransaction: (work) =>
          runInReadCommittedTransaction(database.pool, work),
        lockHomeAndExactMemberships,
        tasks,
        clock: { now: () => DEACTIVATED },
      });
      const leave = createLeaveMembershipFromPool(database.pool);
      const changeRole = createChangeMembershipRoleFromPool(database.pool);

      const userA = randomUUID();
      const userAdmin = randomUUID();
      const homeId = createUuidV7();
      const creatorMembership = createUuidV7();
      const adminMembership = createUuidV7();
      const rejoinedMembership = createUuidV7();
      const userIds = [userA, userAdmin];
      const homeIds = [homeId];

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userAdmin);
        await insertHome(database.pool, { id: homeId, name: 'Tenure Home' });
        await insertMembership(database.pool, {
          id: creatorMembership,
          homeId,
          userId: userA,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: adminMembership,
          homeId,
          userId: userAdmin,
          role: 'ADMIN',
        });

        const created = await create({
          actor: roommate(homeId, creatorMembership, userA),
          homeId,
          title: 'Creator owns this',
          frequency: 'DAILY',
          assignedMembershipId: creatorMembership,
        });
        assert.equal(created.creatorMembershipId, creatorMembership);
        assert.equal(created.assignedMembershipId, creatorMembership);
        const cursorBefore = await database.pool.query<{
          next_occurrence_date: string;
          next_occurrence_at: Date;
        }>(
          `SELECT next_occurrence_date::text AS next_occurrence_date,
                  next_occurrence_at
           FROM task_definitions WHERE id = $1`,
          [created.id],
        );

        await leave({
          actor: roommate(homeId, creatorMembership, userA),
          homeId,
          membershipId: creatorMembership,
        });

        const afterLeave = await database.pool.query<{
          assigned_membership_id: string | null;
          creator_membership_id: string;
          deactivated_at: Date | null;
          next_occurrence_date: string | null;
          next_occurrence_at: Date | null;
        }>(
          `SELECT assigned_membership_id, creator_membership_id, deactivated_at,
                  next_occurrence_date::text AS next_occurrence_date,
                  next_occurrence_at
           FROM task_definitions WHERE id = $1`,
          [created.id],
        );
        assert.equal(afterLeave.rows[0]?.assigned_membership_id, null);
        assert.equal(
          afterLeave.rows[0]?.creator_membership_id,
          creatorMembership,
        );
        assert.equal(afterLeave.rows[0]?.deactivated_at, null);
        assert.equal(
          afterLeave.rows[0]?.next_occurrence_date,
          cursorBefore.rows[0]?.next_occurrence_date,
        );
        assert.equal(
          afterLeave.rows[0]?.next_occurrence_at?.toISOString(),
          cursorBefore.rows[0]?.next_occurrence_at.toISOString(),
        );

        await insertMembership(database.pool, {
          id: rejoinedMembership,
          homeId,
          userId: userA,
          role: 'ROOMMATE',
        });
        const rejoinedRoommate = roommate(homeId, rejoinedMembership, userA);
        await assert.rejects(
          () =>
            deactivate({
              actor: rejoinedRoommate,
              homeId,
              taskDefinitionId: created.id,
            }),
          ConcealedNotFoundError,
        );

        await changeRole({
          actor: admin(homeId, adminMembership, userAdmin),
          homeId,
          membershipId: rejoinedMembership,
          role: 'ADMIN',
        });
        const asAdmin = await deactivate({
          actor: admin(homeId, rejoinedMembership, userA),
          homeId,
          taskDefinitionId: created.id,
        });
        assert.equal(asAdmin.creatorMembershipId, creatorMembership);
        assert.equal(asAdmin.deactivatedAt !== null, true);

        const instances = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM task_instances WHERE home_id = $1`,
          [homeId],
        );
        assert.equal(instances.rows[0]?.count, '0');
        const outbox = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM outbox_events
           WHERE home_id = $1 AND event_type LIKE 'task%'`,
          [homeId],
        );
        assert.equal(outbox.rows[0]?.count, '0');
      } finally {
        await cleanup(database.pool, { userIds, homeIds });
        await database.close();
      }
    },
  );

  void it(
    'persists Pacific/Apia skipped 2011-12-30 as the logical create date',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const tasks = createTaskRepository(database.pool);
      const create = createCreateRecurringTaskDefinition({
        runTransaction: (work) =>
          runInReadCommittedTransaction(database.pool, work),
        lockHomeAndExactMemberships,
        tasks,
        clock: { now: () => APIA_CREATED },
        ids: systemUuidV7,
      });
      const userId = randomUUID();
      const homeId = createUuidV7();
      const membershipId = createUuidV7();

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, {
          id: homeId,
          name: 'Apia',
          timezone: 'Pacific/Apia',
        });
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ADMIN',
        });
        const created = await create({
          actor: admin(homeId, membershipId, userId),
          homeId,
          title: 'Apia daily',
          frequency: 'DAILY',
        });
        const expected = computeInitialRecurrenceCursor({
          frequency: 'DAILY',
          weekday: null,
          dayOfMonth: null,
          homeTimeZone: 'Pacific/Apia',
          createdAt: Temporal.Instant.from(APIA_CREATED.toISOString()),
        });
        assert.equal(created.nextOccurrenceDate, expected.occurrenceDate);
        assert.equal(created.nextOccurrenceDate, '2011-12-30');
        const row = await database.pool.query<{
          next_occurrence_date: string;
          next_occurrence_at: Date;
        }>(
          `SELECT next_occurrence_date::text AS next_occurrence_date,
                  next_occurrence_at
           FROM task_definitions WHERE id = $1`,
          [created.id],
        );
        assert.equal(row.rows[0]?.next_occurrence_date, '2011-12-30');
        assert.equal(
          row.rows[0]?.next_occurrence_at.toISOString(),
          '2011-12-30T10:00:00.000Z',
        );
        assert.equal(
          Temporal.Instant.from(
            row.rows[0]?.next_occurrence_at.toISOString() ?? '',
          )
            .toZonedDateTimeISO('Pacific/Apia')
            .toPlainDate()
            .toString(),
          '2011-12-31',
        );
      } finally {
        await cleanup(database.pool, {
          userIds: [userId],
          homeIds: [homeId],
        });
        await database.close();
      }
    },
  );
});
