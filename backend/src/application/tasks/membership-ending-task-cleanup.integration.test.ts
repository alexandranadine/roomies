import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createArchiveFinalMemberHomeFromPool } from '../home-administration/archive-final-member-home.js';
import { createEndMembershipWithinHomeStructure } from '../home-administration/end-membership-within-home-structure.js';
import { createLeaveMembership } from '../home-administration/leave-membership.js';
import { lockHomeStructure } from '../../domains/homes/lock-home-structure.js';
import { createMembershipEndingWriter } from '../../domains/memberships/update-active-membership-ended-at.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import type { AppConfig } from '../../platform/config/types.js';
import { createOutboxWriter } from '../../platform/events/outbox-writer.js';
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import { createMembershipEndingSupplyCleanupFromPool } from '../supplies/membership-ending-supply-cleanup.js';
import { createMembershipEndingTaskCleanupFromPool } from './membership-ending-task-cleanup.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const ENDED_AT = new Date('2026-03-15T12:34:56.789Z');
const CREATED_AT = new Date('2026-03-01T08:00:00.000Z');
const NEXT_AT = new Date('2026-03-16T00:00:00.000Z');
const DEACTIVATED_AT = new Date('2026-03-10T00:00:00.000Z');

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

function nextEventId(): string {
  return createUuidV7();
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
    endedAt?: Date | null;
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
      input.endedAt === undefined ? null : input.endedAt,
    ],
  );
}

async function insertManualTask(
  pool: Pool,
  input: {
    id: string;
    homeId: string;
    title: string;
    assignedMembershipId: string | null;
    status?: 'OPEN' | 'COMPLETED';
    completedAt?: Date | null;
  },
): Promise<void> {
  const status = input.status ?? 'OPEN';
  await pool.query(
    `INSERT INTO task_instances (
       id, home_id, source, status, title, scheduled_for,
       assigned_membership_id, task_definition_id, completed_at,
       created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, 'MANUAL', $3, $4, NULL, $5::uuid, NULL, $6::timestamptz,
       $7::timestamptz, $7::timestamptz
     )`,
    [
      input.id,
      input.homeId,
      status,
      input.title,
      input.assignedMembershipId,
      status === 'COMPLETED' ? (input.completedAt ?? CREATED_AT) : null,
      CREATED_AT,
    ],
  );
}

async function insertDefinition(
  pool: Pool,
  input: {
    id: string;
    homeId: string;
    title: string;
    assignedMembershipId: string | null;
    creatorMembershipId: string;
    frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY';
    deactivatedAt?: Date | null;
  },
): Promise<void> {
  const weekday = input.frequency === 'WEEKLY' ? 1 : null;
  const dayOfMonth = input.frequency === 'MONTHLY' ? 15 : null;
  const deactivatedAt = input.deactivatedAt ?? null;
  await pool.query(
    `INSERT INTO task_definitions (
       id, home_id, title, assigned_membership_id, creator_membership_id,
       recurrence_frequency, recurrence_weekday, recurrence_day_of_month,
       next_occurrence_date, next_occurrence_at, deactivated_at, created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6, $7, $8,
       $9::date, $10::timestamptz, $11::timestamptz, $12::timestamptz, $12::timestamptz
     )`,
    [
      input.id,
      input.homeId,
      input.title,
      input.assignedMembershipId,
      input.creatorMembershipId,
      input.frequency,
      weekday,
      dayOfMonth,
      deactivatedAt === null ? '2026-03-16' : null,
      deactivatedAt === null ? NEXT_AT : null,
      deactivatedAt,
      CREATED_AT,
    ],
  );
}

async function insertRecurringTask(
  pool: Pool,
  input: {
    id: string;
    homeId: string;
    definitionId: string;
    assignedMembershipId: string | null;
    status?: 'OPEN' | 'COMPLETED';
  },
): Promise<void> {
  const status = input.status ?? 'OPEN';
  await pool.query(
    `INSERT INTO task_instances (
       id, home_id, source, status, title, scheduled_for,
       assigned_membership_id, task_definition_id, completed_at,
       created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, 'RECURRING', $3, 'Recurring chore', DATE '2026-03-14',
       $4::uuid, $5::uuid, $6::timestamptz, $7::timestamptz, $7::timestamptz
     )`,
    [
      input.id,
      input.homeId,
      status,
      input.assignedMembershipId,
      input.definitionId,
      status === 'COMPLETED' ? CREATED_AT : null,
      CREATED_AT,
    ],
  );
}

async function cleanup(
  pool: Pool,
  input: { homeIds: string[]; userIds: string[] },
): Promise<void> {
  if (input.homeIds.length > 0) {
    await pool.query('DELETE FROM task_instances WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query('DELETE FROM task_definitions WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query('DELETE FROM invitations WHERE home_id = ANY($1)', [
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

function leaveCommand(pool: Pool) {
  return createLeaveMembership({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeStructure,
    clock: { now: () => ENDED_AT },
    endMembership: createEndMembershipWithinHomeStructure({
      taskCleanup: createMembershipEndingTaskCleanupFromPool(pool),
      supplyCleanup: createMembershipEndingSupplyCleanupFromPool(pool),
      membershipEnding: createMembershipEndingWriter(),
      outbox: createOutboxWriter(),
      ids: { next: nextEventId },
    }),
  });
}

async function taskAssignment(
  pool: Pool,
  taskId: string,
): Promise<{
  assignedMembershipId: string | null;
  status: string;
  updatedAt: Date;
}> {
  const result = await pool.query<{
    assigned_membership_id: string | null;
    status: string;
    updated_at: Date;
  }>(
    `SELECT assigned_membership_id, status, updated_at
     FROM task_instances WHERE id = $1`,
    [taskId],
  );
  const row = result.rows[0];
  assert.ok(row);
  return {
    assignedMembershipId: row.assigned_membership_id,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

async function definitionRow(
  pool: Pool,
  definitionId: string,
): Promise<{
  assignedMembershipId: string | null;
  creatorMembershipId: string;
  nextOccurrenceDate: string | null;
  nextOccurrenceAt: Date | null;
  deactivatedAt: Date | null;
  updatedAt: Date;
}> {
  const result = await pool.query<{
    assigned_membership_id: string | null;
    creator_membership_id: string;
    next_occurrence_date: string | null;
    next_occurrence_at: Date | null;
    deactivated_at: Date | null;
    updated_at: Date;
  }>(
    `SELECT assigned_membership_id, creator_membership_id,
            next_occurrence_date::text AS next_occurrence_date,
            next_occurrence_at, deactivated_at, updated_at
     FROM task_definitions WHERE id = $1`,
    [definitionId],
  );
  const row = result.rows[0];
  assert.ok(row);
  return {
    assignedMembershipId: row.assigned_membership_id,
    creatorMembershipId: row.creator_membership_id,
    nextOccurrenceDate: row.next_occurrence_date,
    nextOccurrenceAt: row.next_occurrence_at,
    deactivatedAt: row.deactivated_at,
    updatedAt: row.updated_at,
  };
}

void describe('Membership-ending Task cleanup PostgreSQL', () => {
  void it(
    'unassigns OPEN TaskInstances for the ending Membership and keeps COMPLETED history',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const adminUser = randomUUID();
      const leavingUser = randomUUID();
      const homeId = randomUUID();
      const otherHome = randomUUID();
      const adminMembership = randomUUID();
      const leavingMembership = randomUUID();
      const otherHomeMembership = randomUUID();
      const openManual = createUuidV7();
      const completedManual = createUuidV7();
      const openRecurring = createUuidV7();
      const completedRecurring = createUuidV7();
      const otherHomeOpen = createUuidV7();
      const dailyId = createUuidV7();
      const weeklyId = createUuidV7();
      const monthlyId = createUuidV7();
      const inactiveId = createUuidV7();
      const creatorOnlyId = createUuidV7();
      const selfAssignedId = createUuidV7();
      const otherHomeDef = createUuidV7();
      const recurringDef = createUuidV7();
      const completedRecurringDef = createUuidV7();

      try {
        await insertUser(database.pool, adminUser);
        await insertUser(database.pool, leavingUser);
        await insertHome(database.pool, homeId, 'Cleanup home');
        await insertHome(database.pool, otherHome, 'Other home');
        await insertMembership(database.pool, {
          id: adminMembership,
          homeId,
          userId: adminUser,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: leavingMembership,
          homeId,
          userId: leavingUser,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: otherHomeMembership,
          homeId: otherHome,
          userId: leavingUser,
          role: 'ADMIN',
        });

        await insertDefinition(database.pool, {
          id: dailyId,
          homeId,
          title: 'Daily',
          assignedMembershipId: leavingMembership,
          creatorMembershipId: adminMembership,
          frequency: 'DAILY',
        });
        await insertDefinition(database.pool, {
          id: weeklyId,
          homeId,
          title: 'Weekly',
          assignedMembershipId: leavingMembership,
          creatorMembershipId: adminMembership,
          frequency: 'WEEKLY',
        });
        await insertDefinition(database.pool, {
          id: monthlyId,
          homeId,
          title: 'Monthly',
          assignedMembershipId: leavingMembership,
          creatorMembershipId: adminMembership,
          frequency: 'MONTHLY',
        });
        await insertDefinition(database.pool, {
          id: inactiveId,
          homeId,
          title: 'Inactive',
          assignedMembershipId: leavingMembership,
          creatorMembershipId: adminMembership,
          frequency: 'DAILY',
          deactivatedAt: DEACTIVATED_AT,
        });
        await insertDefinition(database.pool, {
          id: creatorOnlyId,
          homeId,
          title: 'Created by leaving member',
          assignedMembershipId: adminMembership,
          creatorMembershipId: leavingMembership,
          frequency: 'DAILY',
        });
        await insertDefinition(database.pool, {
          id: selfAssignedId,
          homeId,
          title: 'Self assigned',
          assignedMembershipId: leavingMembership,
          creatorMembershipId: leavingMembership,
          frequency: 'DAILY',
        });
        await insertDefinition(database.pool, {
          id: otherHomeDef,
          homeId: otherHome,
          title: 'Other home def',
          assignedMembershipId: otherHomeMembership,
          creatorMembershipId: otherHomeMembership,
          frequency: 'DAILY',
        });
        await insertDefinition(database.pool, {
          id: recurringDef,
          homeId,
          title: 'Open recurring source',
          assignedMembershipId: leavingMembership,
          creatorMembershipId: adminMembership,
          frequency: 'DAILY',
        });
        await insertDefinition(database.pool, {
          id: completedRecurringDef,
          homeId,
          title: 'Completed recurring source',
          assignedMembershipId: adminMembership,
          creatorMembershipId: adminMembership,
          frequency: 'DAILY',
        });

        await insertManualTask(database.pool, {
          id: openManual,
          homeId,
          title: 'Open manual',
          assignedMembershipId: leavingMembership,
        });
        await insertManualTask(database.pool, {
          id: completedManual,
          homeId,
          title: 'Completed manual',
          assignedMembershipId: leavingMembership,
          status: 'COMPLETED',
        });
        await insertRecurringTask(database.pool, {
          id: openRecurring,
          homeId,
          definitionId: recurringDef,
          assignedMembershipId: leavingMembership,
        });
        await insertRecurringTask(database.pool, {
          id: completedRecurring,
          homeId,
          definitionId: completedRecurringDef,
          assignedMembershipId: leavingMembership,
          status: 'COMPLETED',
        });
        await insertManualTask(database.pool, {
          id: otherHomeOpen,
          homeId: otherHome,
          title: 'Other home open',
          assignedMembershipId: otherHomeMembership,
        });

        await leaveCommand(database.pool)({
          homeId,
          membershipId: leavingMembership,
          actor: actor({
            userId: leavingUser,
            membershipId: leavingMembership,
            homeId,
            role: 'ROOMMATE',
          }),
        });

        const openAfter = await taskAssignment(database.pool, openManual);
        assert.equal(openAfter.assignedMembershipId, null);
        assert.equal(openAfter.status, 'OPEN');
        assert.equal(openAfter.updatedAt.getTime(), ENDED_AT.getTime());

        const completedAfter = await taskAssignment(
          database.pool,
          completedManual,
        );
        assert.equal(completedAfter.assignedMembershipId, leavingMembership);
        assert.equal(completedAfter.status, 'COMPLETED');
        assert.equal(completedAfter.updatedAt.getTime(), CREATED_AT.getTime());

        const openRecurringAfter = await taskAssignment(
          database.pool,
          openRecurring,
        );
        assert.equal(openRecurringAfter.assignedMembershipId, null);
        assert.equal(openRecurringAfter.status, 'OPEN');

        const completedRecurringAfter = await taskAssignment(
          database.pool,
          completedRecurring,
        );
        assert.equal(
          completedRecurringAfter.assignedMembershipId,
          leavingMembership,
        );

        const otherHomeAfter = await taskAssignment(
          database.pool,
          otherHomeOpen,
        );
        assert.equal(otherHomeAfter.assignedMembershipId, otherHomeMembership);

        const daily = await definitionRow(database.pool, dailyId);
        const weekly = await definitionRow(database.pool, weeklyId);
        const monthly = await definitionRow(database.pool, monthlyId);
        assert.equal(daily.assignedMembershipId, null);
        assert.equal(weekly.assignedMembershipId, null);
        assert.equal(monthly.assignedMembershipId, null);
        assert.equal(daily.updatedAt.getTime(), ENDED_AT.getTime());
        assert.equal(daily.creatorMembershipId, adminMembership);
        assert.equal(daily.nextOccurrenceDate, '2026-03-16');
        assert.equal(daily.nextOccurrenceAt?.getTime(), NEXT_AT.getTime());

        const inactive = await definitionRow(database.pool, inactiveId);
        assert.equal(inactive.assignedMembershipId, leavingMembership);
        assert.equal(inactive.nextOccurrenceDate, null);
        assert.equal(inactive.nextOccurrenceAt, null);
        assert.ok(inactive.deactivatedAt);

        const creatorOnly = await definitionRow(database.pool, creatorOnlyId);
        assert.equal(creatorOnly.creatorMembershipId, leavingMembership);
        assert.equal(creatorOnly.assignedMembershipId, adminMembership);

        const selfAssigned = await definitionRow(database.pool, selfAssignedId);
        assert.equal(selfAssigned.creatorMembershipId, leavingMembership);
        assert.equal(selfAssigned.assignedMembershipId, null);

        const otherDef = await definitionRow(database.pool, otherHomeDef);
        assert.equal(otherDef.assignedMembershipId, otherHomeMembership);

        const ended = await database.pool.query<{ ended_at: Date | null }>(
          'SELECT ended_at FROM memberships WHERE id = $1',
          [leavingMembership],
        );
        assert.equal(ended.rows[0]?.ended_at?.getTime(), ENDED_AT.getTime());

        const historicalFk = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM task_instances t
           JOIN memberships m
             ON m.id = t.assigned_membership_id
            AND m.home_id = t.home_id
           WHERE t.id = $1 AND m.ended_at IS NOT NULL`,
          [completedManual],
        );
        assert.equal(historicalFk.rows[0]?.count, '1');

        const taskEvents = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM outbox_events
           WHERE home_id = ANY($1::uuid[])
             AND event_type LIKE 'task.%'`,
          [[homeId, otherHome]],
        );
        assert.equal(taskEvents.rows[0]?.count, '0');

        const membershipEvents = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM outbox_events
           WHERE home_id = $1 AND event_type = 'membership.ended.v1'`,
          [homeId],
        );
        assert.equal(membershipEvents.rows[0]?.count, '1');

        const instanceCount = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM task_instances
           WHERE home_id = ANY($1::uuid[])`,
          [[homeId, otherHome]],
        );
        assert.equal(instanceCount.rows[0]?.count, '5');
        const definitionCount = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM task_definitions
           WHERE home_id = ANY($1::uuid[])`,
          [[homeId, otherHome]],
        );
        assert.equal(definitionCount.rows[0]?.count, '9');
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId, otherHome],
          userIds: [adminUser, leavingUser],
        });
        await database.close();
      }
    },
  );

  void it(
    'does not clear another Membership tenure or a rejoined tenure',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const adminUser = randomUUID();
      const leavingUser = randomUUID();
      const stayingUser = randomUUID();
      const homeId = randomUUID();
      const adminMembership = randomUUID();
      const oldMembership = randomUUID();
      const stayingMembership = randomUUID();
      const rejoinedMembership = randomUUID();
      const stayingTask = createUuidV7();
      const rejoinedTask = createUuidV7();
      const rejoinedDef = createUuidV7();
      const oldOpen = createUuidV7();

      try {
        await insertUser(database.pool, adminUser);
        await insertUser(database.pool, leavingUser);
        await insertUser(database.pool, stayingUser);
        await insertHome(database.pool, homeId, 'Rejoin home');
        await insertMembership(database.pool, {
          id: adminMembership,
          homeId,
          userId: adminUser,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: oldMembership,
          homeId,
          userId: leavingUser,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: stayingMembership,
          homeId,
          userId: stayingUser,
          role: 'ROOMMATE',
        });
        await insertManualTask(database.pool, {
          id: oldOpen,
          homeId,
          title: 'Old tenure open',
          assignedMembershipId: oldMembership,
        });
        await insertManualTask(database.pool, {
          id: stayingTask,
          homeId,
          title: 'Staying member',
          assignedMembershipId: stayingMembership,
        });

        await leaveCommand(database.pool)({
          homeId,
          membershipId: oldMembership,
          actor: actor({
            userId: leavingUser,
            membershipId: oldMembership,
            homeId,
            role: 'ROOMMATE',
          }),
        });

        await insertMembership(database.pool, {
          id: rejoinedMembership,
          homeId,
          userId: leavingUser,
          role: 'ROOMMATE',
        });
        await insertManualTask(database.pool, {
          id: rejoinedTask,
          homeId,
          title: 'Rejoined tenure',
          assignedMembershipId: rejoinedMembership,
        });
        await insertDefinition(database.pool, {
          id: rejoinedDef,
          homeId,
          title: 'Rejoined definition',
          assignedMembershipId: rejoinedMembership,
          creatorMembershipId: rejoinedMembership,
          frequency: 'DAILY',
        });

        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await createMembershipEndingTaskCleanupFromPool(
            database.pool,
          ).handleMembershipEnded(tx, {
            homeId,
            membershipId: oldMembership,
            endedAt: ENDED_AT,
            cause: 'VOLUNTARY_LEAVE',
          });
        });

        assert.equal(
          (await taskAssignment(database.pool, oldOpen)).assignedMembershipId,
          null,
        );
        assert.equal(
          (await taskAssignment(database.pool, stayingTask))
            .assignedMembershipId,
          stayingMembership,
        );
        assert.equal(
          (await taskAssignment(database.pool, rejoinedTask))
            .assignedMembershipId,
          rejoinedMembership,
        );
        assert.equal(
          (await definitionRow(database.pool, rejoinedDef))
            .assignedMembershipId,
          rejoinedMembership,
        );
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [adminUser, leavingUser, stayingUser],
        });
        await database.close();
      }
    },
  );

  void it(
    'rolls Task cleanup back when a later membership-ending step fails',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const adminUser = randomUUID();
      const leavingUser = randomUUID();
      const homeId = randomUUID();
      const adminMembership = randomUUID();
      const leavingMembership = randomUUID();
      const openId = createUuidV7();
      const defId = createUuidV7();
      const endMembership = createEndMembershipWithinHomeStructure({
        taskCleanup: createMembershipEndingTaskCleanupFromPool(database.pool),
        supplyCleanup: {
          handleMembershipEnded() {
            return Promise.reject(new Error('injected supply cleanup failure'));
          },
        },
        membershipEnding: createMembershipEndingWriter(),
        outbox: createOutboxWriter(),
        ids: { next: nextEventId },
      });

      try {
        await insertUser(database.pool, adminUser);
        await insertUser(database.pool, leavingUser);
        await insertHome(database.pool, homeId, 'Rollback home');
        await insertMembership(database.pool, {
          id: adminMembership,
          homeId,
          userId: adminUser,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: leavingMembership,
          homeId,
          userId: leavingUser,
          role: 'ROOMMATE',
        });
        await insertManualTask(database.pool, {
          id: openId,
          homeId,
          title: 'Should roll back',
          assignedMembershipId: leavingMembership,
        });
        await insertDefinition(database.pool, {
          id: defId,
          homeId,
          title: 'Should roll back def',
          assignedMembershipId: leavingMembership,
          creatorMembershipId: adminMembership,
          frequency: 'DAILY',
        });

        await assert.rejects(
          () =>
            runInReadCommittedTransaction(database.pool, async (tx) => {
              await lockHomeStructure(tx, {
                homeId,
                actor: actor({
                  userId: leavingUser,
                  membershipId: leavingMembership,
                  homeId,
                  role: 'ROOMMATE',
                }),
              });
              await endMembership(tx, {
                homeId,
                membershipId: leavingMembership,
                endedAt: ENDED_AT,
                cause: 'VOLUNTARY_LEAVE',
              });
            }),
          /injected supply cleanup failure/,
        );

        assert.equal(
          (await taskAssignment(database.pool, openId)).assignedMembershipId,
          leavingMembership,
        );
        assert.equal(
          (await definitionRow(database.pool, defId)).assignedMembershipId,
          leavingMembership,
        );
        const membership = await database.pool.query<{ ended_at: Date | null }>(
          'SELECT ended_at FROM memberships WHERE id = $1',
          [leavingMembership],
        );
        assert.equal(membership.rows[0]?.ended_at, null);
        const events = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM outbox_events WHERE home_id = $1`,
          [homeId],
        );
        assert.equal(events.rows[0]?.count, '0');
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [adminUser, leavingUser],
        });
        await database.close();
      }
    },
  );

  void it(
    'performs the same cleanup on the final-member Home archive path',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userId = randomUUID();
      const homeId = randomUUID();
      const membershipId = randomUUID();
      const openId = createUuidV7();
      const completedId = createUuidV7();
      const activeDef = createUuidV7();
      const inactiveDef = createUuidV7();
      const archive = createArchiveFinalMemberHomeFromPool(database.pool);

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, homeId, 'Archive cleanup');
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ADMIN',
        });
        await insertManualTask(database.pool, {
          id: openId,
          homeId,
          title: 'Archive open',
          assignedMembershipId: membershipId,
        });
        await insertManualTask(database.pool, {
          id: completedId,
          homeId,
          title: 'Archive completed',
          assignedMembershipId: membershipId,
          status: 'COMPLETED',
        });
        await insertDefinition(database.pool, {
          id: activeDef,
          homeId,
          title: 'Archive active',
          assignedMembershipId: membershipId,
          creatorMembershipId: membershipId,
          frequency: 'DAILY',
        });
        await insertDefinition(database.pool, {
          id: inactiveDef,
          homeId,
          title: 'Archive inactive',
          assignedMembershipId: membershipId,
          creatorMembershipId: membershipId,
          frequency: 'DAILY',
          deactivatedAt: DEACTIVATED_AT,
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

        assert.equal(
          (await taskAssignment(database.pool, openId)).assignedMembershipId,
          null,
        );
        assert.equal(
          (await taskAssignment(database.pool, completedId))
            .assignedMembershipId,
          membershipId,
        );
        const active = await definitionRow(database.pool, activeDef);
        assert.equal(active.assignedMembershipId, null);
        assert.equal(active.creatorMembershipId, membershipId);
        assert.equal(
          (await definitionRow(database.pool, inactiveDef))
            .assignedMembershipId,
          membershipId,
        );

        const home = await database.pool.query<{ archived_at: Date | null }>(
          'SELECT archived_at FROM homes WHERE id = $1',
          [homeId],
        );
        assert.ok(home.rows[0]?.archived_at);
        const membership = await database.pool.query<{ ended_at: Date | null }>(
          'SELECT ended_at FROM memberships WHERE id = $1',
          [membershipId],
        );
        assert.ok(membership.rows[0]?.ended_at);

        const remaining = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM task_instances WHERE home_id = $1`,
          [homeId],
        );
        assert.equal(remaining.rows[0]?.count, '2');
        const taskEvents = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM outbox_events
           WHERE home_id = $1 AND event_type LIKE 'task.%'`,
          [homeId],
        );
        assert.equal(taskEvents.rows[0]?.count, '0');
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
    'treats zero matching Task rows as success and still ends the Membership',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const adminUser = randomUUID();
      const leavingUser = randomUUID();
      const homeId = randomUUID();
      const adminMembership = randomUUID();
      const leavingMembership = randomUUID();

      try {
        await insertUser(database.pool, adminUser);
        await insertUser(database.pool, leavingUser);
        await insertHome(database.pool, homeId, 'Empty cleanup');
        await insertMembership(database.pool, {
          id: adminMembership,
          homeId,
          userId: adminUser,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: leavingMembership,
          homeId,
          userId: leavingUser,
          role: 'ROOMMATE',
        });

        await leaveCommand(database.pool)({
          homeId,
          membershipId: leavingMembership,
          actor: actor({
            userId: leavingUser,
            membershipId: leavingMembership,
            homeId,
            role: 'ROOMMATE',
          }),
        });

        const ended = await database.pool.query<{ ended_at: Date | null }>(
          'SELECT ended_at FROM memberships WHERE id = $1',
          [leavingMembership],
        );
        assert.equal(ended.rows[0]?.ended_at?.getTime(), ENDED_AT.getTime());
        const tasks = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM task_instances WHERE home_id = $1`,
          [homeId],
        );
        assert.equal(tasks.rows[0]?.count, '0');
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [adminUser, leavingUser],
        });
        await database.close();
      }
    },
  );
});
