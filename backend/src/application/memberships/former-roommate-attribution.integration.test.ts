import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createDeleteAccountLifecycleFromPool } from '../account/delete-account-lifecycle.js';
import { createListHomeActivityFromPool } from '../activity/list-home-activity.js';
import { createCreateInvitationFromPool } from '../home-administration/create-invitation.js';
import { createLeaveMembershipFromPool } from '../home-administration/leave-membership.js';
import {
  createActiveHomesForUserReader,
  listActiveHomesForUser,
} from '../../domains/homes/index.js';
import { findHistoricalMembershipDisplays } from '../../domains/memberships/find-historical-membership-display.js';
import { createActiveHomeActorResolver } from '../../domains/memberships/active-home-actor-resolver.js';
import { TASK_COMPLETED_V1 } from '../../domains/tasks/events.js';
import { SUPPLY_OBTAINED_V1 } from '../../domains/supplies/events.js';
import { createCreateMaintenanceEntryFromPool } from '../maintenance/create-maintenance-entry.js';
import { createListHomeMaintenanceFromPool } from '../maintenance/list-home-maintenance.js';
import { createReadMaintenanceEntryFromPool } from '../maintenance/read-maintenance-entry.js';
import { createResolveMaintenanceEntryFromPool } from '../maintenance/resolve-maintenance-entry.js';
import { createListActiveHomeMembershipsFromPool } from './list-active-home-memberships.js';
import { createListCurrentUserNotificationsFromPool } from '../notifications/list-current-user-notifications.js';
import { createGetHousePulseFromPool } from '../pulse/get-house-pulse.js';
import { createCreateSupplyEntryFromPool } from '../supplies/create-supply-entry.js';
import { createMarkSupplyEntryObtainedFromPool } from '../supplies/mark-supply-entry-obtained.js';
import { createCompleteTaskFromPool } from '../tasks/complete-task.js';
import { createCreateManualTaskFromPool } from '../tasks/create-manual-task.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  ForbiddenError,
} from '../../platform/authz/errors.js';
import type { AppConfig } from '../../platform/config/types.js';
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { createActivityRepository } from '../../domains/activity/repository.js';
import {
  createNotificationRepository,
  type NewNotification,
} from '../../domains/notifications/repository.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const LIFECYCLE_AT = new Date('2026-09-24T18:00:00.000Z');
const CREATED_AT = new Date('2026-09-01T12:00:00.000Z');

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
  return input;
}

async function insertIdentity(
  pool: Pool,
  input: { id: string; name: string; email: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO auth_identities (id, name, email, email_verified)
     VALUES ($1, $2, $3, true)`,
    [input.id, input.name, input.email],
  );
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
    role: 'ADMIN' | 'ROOMMATE';
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO memberships (
       id, home_id, user_id, role, joined_at, ended_at, ended_by_membership_id
     ) VALUES ($1, $2, $3, $4, $5, NULL, NULL)`,
    [input.id, input.homeId, input.userId, input.role, CREATED_AT],
  );
}

async function insertHomeVisibleActivity(
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
      occurredAt: CREATED_AT,
      createdAt: CREATED_AT,
    });
  });
  return id;
}

async function insertNotification(
  pool: Pool,
  input: NewNotification,
): Promise<void> {
  const notifications = createNotificationRepository(pool);
  await runInReadCommittedTransaction(pool, async (tx) => {
    await notifications.insertNotification(tx, input);
  });
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
      'DELETE FROM supply_claims WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query(
      'DELETE FROM supply_entries WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query(
      'DELETE FROM task_instances WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query(
      'DELETE FROM task_definitions WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query(
      'DELETE FROM invitations WHERE home_id = ANY($1::uuid[])',
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
  }
  if (input.userIds.length > 0) {
    await pool.query(
      'DELETE FROM auth_accounts WHERE user_id = ANY($1::uuid[])',
      [input.userIds],
    );
    await pool.query(
      'DELETE FROM auth_sessions WHERE user_id = ANY($1::uuid[])',
      [input.userIds],
    );
    await pool.query('DELETE FROM auth_identities WHERE id = ANY($1::uuid[])', [
      input.userIds,
    ]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
      input.userIds,
    ]);
  }
}

function pulseMaintenanceCount(
  pulse: Awaited<ReturnType<ReturnType<typeof createGetHousePulseFromPool>>>,
): number {
  const section = pulse.items.find((item) => item.type === 'MAINTENANCE');
  assert.ok(section);
  return section.openVisibleCount;
}

void describe('former-roommate attribution PostgreSQL', () => {
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
    'keeps historical tenure A after leave and isolates rejoin tenure B',
    { skip: skipWithoutDatabase, timeout: 90_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const suffix = randomUUID();
      const homeId = createUuidV7();
      const userA = randomUUID();
      const userStay = randomUUID();
      const membershipA = createUuidV7();
      const membershipStay = createUuidV7();
      const membershipB = createUuidV7();
      const createTask = createCreateManualTaskFromPool(database.pool);
      const completeTask = createCompleteTaskFromPool(database.pool);
      const createSupply = createCreateSupplyEntryFromPool(database.pool);
      const obtainSupply = createMarkSupplyEntryObtainedFromPool(database.pool);
      const createMaintenance = createCreateMaintenanceEntryFromPool(
        database.pool,
      );
      const leave = createLeaveMembershipFromPool(database.pool);
      const createInvitation = createCreateInvitationFromPool(database.pool);
      const listActivity = createListHomeActivityFromPool(database.pool);
      const listMaintenance = createListHomeMaintenanceFromPool(database.pool);
      const readMaintenance = createReadMaintenanceEntryFromPool(database.pool);
      const resolveMaintenance = createResolveMaintenanceEntryFromPool(
        database.pool,
      );
      const listMembers = createListActiveHomeMembershipsFromPool(
        database.pool,
      );
      const getPulse = createGetHousePulseFromPool(database.pool);
      const homesReader = createActiveHomesForUserReader(database.pool);
      const resolver = createActiveHomeActorResolver(database.pool);
      const actorA = actor({
        userId: userA,
        membershipId: membershipA,
        homeId,
        role: 'ADMIN',
      });
      const actorStay = actor({
        userId: userStay,
        membershipId: membershipStay,
        homeId,
        role: 'ADMIN',
      });

      try {
        await insertIdentity(database.pool, {
          id: userA,
          name: 'Alex Rivera',
          email: `alex-${suffix}@example.test`,
        });
        await insertIdentity(database.pool, {
          id: userStay,
          name: 'Jamie Chen',
          email: `jamie-${suffix}@example.test`,
        });
        await insertHome(database.pool, homeId, 'Attribution Home');
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipStay,
          homeId,
          userId: userStay,
          role: 'ADMIN',
        });

        const completed = await completeTask({
          actor: actorA,
          homeId,
          taskId: (
            await createTask({
              actor: actorA,
              homeId,
              title: 'Take out trash',
            })
          ).id,
        });
        const obtained = await obtainSupply({
          actor: actorA,
          homeId,
          supplyEntryId: (
            await createSupply({
              actor: actorA,
              homeId,
              title: 'Paper towels',
            })
          ).id,
        });
        const privateEntry = await createMaintenance({
          actor: actorA,
          homeId,
          visibility: 'PRIVATE',
          title: 'A-only private',
          audienceMembershipIds: [],
        });
        const household = await createMaintenance({
          actor: actorStay,
          homeId,
          visibility: 'HOUSEHOLD',
          title: 'Shared household',
        });
        await insertHomeVisibleActivity(database.pool, {
          homeId,
          sourceEntityType: 'TASK',
          sourceEntityId: completed.id,
          actorMembershipId: membershipA,
          eventType: TASK_COMPLETED_V1,
        });
        await insertHomeVisibleActivity(database.pool, {
          homeId,
          sourceEntityType: 'SUPPLY',
          sourceEntityId: obtained.id,
          actorMembershipId: membershipA,
          eventType: SUPPLY_OBTAINED_V1,
        });

        await leave({
          actor: actorA,
          homeId,
          membershipId: membershipA,
        });

        const endedRow = await database.pool.query<{
          ended_at: Date | null;
          role: string;
        }>('SELECT ended_at, role FROM memberships WHERE id = $1', [
          membershipA,
        ]);
        assert.ok(endedRow.rows[0]?.ended_at);
        assert.equal(endedRow.rows[0]?.role, 'ADMIN');
        assert.equal(await resolver.resolve({ userId: userA, homeId }), null);
        assert.deepEqual(
          await listActiveHomesForUser({ userId: userA }, homesReader),
          [],
        );
        const stayMembers = await listMembers({
          actor: actorStay,
          homeId,
        });
        assert.equal(
          stayMembers.some((row) => row.membershipId === membershipA),
          false,
        );
        assert.ok(
          stayMembers.some((row) => row.membershipId === membershipStay),
        );

        await assert.rejects(
          () =>
            createTask({
              actor: actorA,
              homeId,
              title: 'Should not create',
            }),
          ConcealedNotFoundError,
        );
        await assert.rejects(
          () =>
            createInvitation({
              actor: actorA,
              homeId,
              email: `invite-${suffix}@example.test`,
            }),
          ConcealedNotFoundError,
        );
        await assert.rejects(
          () =>
            resolveMaintenance({
              actor: actorA,
              homeId,
              maintenanceEntryId: household.id,
            }),
          ConcealedNotFoundError,
        );

        const historyAfterLeave = await listActivity({
          actor: actorStay,
          homeId,
        });
        const completedActivity = historyAfterLeave.items.find(
          (item) => item.sourceEntityId === completed.id,
        );
        assert.equal(completedActivity?.actor?.membershipId, membershipA);
        assert.equal(completedActivity?.actor?.name, 'Alex Rivera');
        const obtainedActivity = historyAfterLeave.items.find(
          (item) => item.sourceEntityId === obtained.id,
        );
        assert.equal(obtainedActivity?.actor?.membershipId, membershipA);
        const taskRow = await database.pool.query<{
          completed_by_membership_id: string | null;
          assigned_membership_id: string | null;
        }>(
          `SELECT completed_by_membership_id, assigned_membership_id
           FROM task_instances WHERE id = $1`,
          [completed.id],
        );
        assert.equal(taskRow.rows[0]?.completed_by_membership_id, membershipA);
        const supplyRow = await database.pool.query<{
          obtained_by_membership_id: string | null;
        }>(
          'SELECT obtained_by_membership_id FROM supply_entries WHERE id = $1',
          [obtained.id],
        );
        assert.equal(supplyRow.rows[0]?.obtained_by_membership_id, membershipA);

        await insertMembership(database.pool, {
          id: membershipB,
          homeId,
          userId: userA,
          role: 'ROOMMATE',
        });
        const actorB = actor({
          userId: userA,
          membershipId: membershipB,
          homeId,
          role: 'ROOMMATE',
        });

        const aStillEnded = await database.pool.query<{
          ended_at: Date | null;
        }>('SELECT ended_at FROM memberships WHERE id = $1', [membershipA]);
        const bActive = await database.pool.query<{
          ended_at: Date | null;
          role: string;
        }>('SELECT ended_at, role FROM memberships WHERE id = $1', [
          membershipB,
        ]);
        assert.ok(aStillEnded.rows[0]?.ended_at);
        assert.equal(bActive.rows[0]?.ended_at, null);
        assert.equal(bActive.rows[0]?.role, 'ROOMMATE');
        assert.notEqual(membershipA, membershipB);

        const currentActor = await resolver.resolve({ userId: userA, homeId });
        assert.equal(currentActor?.membershipId, membershipB);
        assert.notEqual(currentActor?.membershipId, membershipA);
        assert.equal(currentActor?.role, 'ROOMMATE');

        const homesAfterRejoin = await listActiveHomesForUser(
          { userId: userA },
          homesReader,
        );
        assert.deepEqual(
          homesAfterRejoin.map((home) => ({ id: home.id, role: home.role })),
          [{ id: homeId, role: 'ROOMMATE' }],
        );
        const membersAfterRejoin = await listMembers({
          actor: actorB,
          homeId,
        });
        assert.equal(
          membersAfterRejoin.some((row) => row.membershipId === membershipA),
          false,
        );
        assert.ok(
          membersAfterRejoin.some((row) => row.membershipId === membershipB),
        );

        const taskAfterRejoin = await database.pool.query<{
          completed_by_membership_id: string;
        }>(
          'SELECT completed_by_membership_id FROM task_instances WHERE id = $1',
          [completed.id],
        );
        assert.equal(
          taskAfterRejoin.rows[0]?.completed_by_membership_id,
          membershipA,
        );
        const supplyAfterRejoin = await database.pool.query<{
          obtained_by_membership_id: string;
        }>(
          'SELECT obtained_by_membership_id FROM supply_entries WHERE id = $1',
          [obtained.id],
        );
        assert.equal(
          supplyAfterRejoin.rows[0]?.obtained_by_membership_id,
          membershipA,
        );

        const newTask = await completeTask({
          actor: actorB,
          homeId,
          taskId: (
            await createTask({
              actor: actorB,
              homeId,
              title: 'Tenure B task',
            })
          ).id,
        });
        assert.equal(newTask.completedByMembershipId, membershipB);
        assert.notEqual(newTask.completedByMembershipId, membershipA);

        await assert.rejects(
          () =>
            createInvitation({
              actor: actorB,
              homeId,
              email: `invite-b-${suffix}@example.test`,
            }),
          ForbiddenError,
        );
        await assert.rejects(
          () =>
            createInvitation({
              actor: actorA,
              homeId,
              email: `invite-old-${suffix}@example.test`,
            }),
          ConcealedNotFoundError,
        );

        await assert.rejects(
          () =>
            readMaintenance({
              actor: actorB,
              homeId,
              maintenanceEntryId: privateEntry.id,
            }),
          ConcealedNotFoundError,
        );
        await assert.rejects(
          () =>
            resolveMaintenance({
              actor: actorB,
              homeId,
              maintenanceEntryId: privateEntry.id,
            }),
          ConcealedNotFoundError,
        );
        const visible = await listMaintenance({ actor: actorB, homeId });
        assert.equal(
          visible.items.some((item) => item.id === privateEntry.id),
          false,
        );
        assert.ok(visible.items.some((item) => item.id === household.id));
        assert.equal(
          pulseMaintenanceCount(await getPulse({ actor: actorB, homeId })),
          1,
        );
        const privateStillOpen = await database.pool.query<{
          status: string;
          resolved_by_membership_id: string | null;
        }>(
          'SELECT status, resolved_by_membership_id FROM maintenance_entries WHERE id = $1',
          [privateEntry.id],
        );
        assert.equal(privateStillOpen.rows[0]?.status, 'OPEN');
        assert.equal(privateStillOpen.rows[0]?.resolved_by_membership_id, null);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userA, userStay],
        });
        await database.close();
      }
    },
  );

  void it(
    'anonymizes historical presentation after leave then account deletion',
    { skip: skipWithoutDatabase, timeout: 90_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const suffix = randomUUID();
      const homeId = createUuidV7();
      const userA = randomUUID();
      const userStay = randomUUID();
      const membershipA = createUuidV7();
      const membershipStay = createUuidV7();
      const createTask = createCreateManualTaskFromPool(database.pool);
      const completeTask = createCompleteTaskFromPool(database.pool);
      const createMaintenance = createCreateMaintenanceEntryFromPool(
        database.pool,
      );
      const leave = createLeaveMembershipFromPool(database.pool);
      const listActivity = createListHomeActivityFromPool(database.pool);
      const listNotifications = createListCurrentUserNotificationsFromPool(
        database.pool,
      );
      const listMaintenance = createListHomeMaintenanceFromPool(database.pool);
      const resolver = createActiveHomeActorResolver(database.pool);
      const actorA = actor({
        userId: userA,
        membershipId: membershipA,
        homeId,
        role: 'ROOMMATE',
      });
      const actorStay = actor({
        userId: userStay,
        membershipId: membershipStay,
        homeId,
        role: 'ADMIN',
      });

      try {
        await insertIdentity(database.pool, {
          id: userA,
          name: 'Alex Rivera',
          email: `alex-del-${suffix}@example.test`,
        });
        await insertIdentity(database.pool, {
          id: userStay,
          name: 'Jamie Chen',
          email: `jamie-del-${suffix}@example.test`,
        });
        await insertHome(database.pool, homeId, 'Delete After Leave');
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: membershipStay,
          homeId,
          userId: userStay,
          role: 'ADMIN',
        });

        const completed = await completeTask({
          actor: actorA,
          homeId,
          taskId: (
            await createTask({
              actor: actorA,
              homeId,
              title: 'Completed before leave',
            })
          ).id,
        });
        const authored = await createMaintenance({
          actor: actorA,
          homeId,
          visibility: 'HOUSEHOLD',
          title: 'Authored by A',
        });
        await insertHomeVisibleActivity(database.pool, {
          homeId,
          sourceEntityType: 'TASK',
          sourceEntityId: completed.id,
          actorMembershipId: membershipA,
          eventType: TASK_COMPLETED_V1,
        });
        await insertNotification(database.pool, {
          id: createUuidV7(),
          homeId,
          recipientMembershipId: membershipStay,
          sourceOutboxEventId: createUuidV7(),
          kind: 'ASSIGNED_TASK_COMPLETED',
          sourceEntityType: 'TASK',
          sourceEntityId: completed.id,
          actorMembershipId: membershipA,
          occurredAt: CREATED_AT,
          createdAt: CREATED_AT,
          readAt: null,
        });

        const namedBefore = await findHistoricalMembershipDisplays(
          database.pool,
          { homeId, membershipIds: [membershipA] },
        );
        assert.equal(namedBefore.get(membershipA)?.name, 'Alex Rivera');

        await leave({
          actor: actorA,
          homeId,
          membershipId: membershipA,
        });

        const result = await createDeleteAccountLifecycleFromPool(
          database.pool,
          { clock: { now: () => LIFECYCLE_AT } },
        )({ userId: userA });
        assert.equal(result.outcome, 'completed');

        const userRow = await database.pool.query<{
          deleted_at: Date | null;
        }>('SELECT deleted_at FROM users WHERE id = $1', [userA]);
        assert.equal(
          userRow.rows[0]?.deleted_at?.getTime(),
          LIFECYCLE_AT.getTime(),
        );
        const identities = await database.pool.query(
          'SELECT id FROM auth_identities WHERE id = $1',
          [userA],
        );
        assert.equal(identities.rowCount, 0);
        const tenure = await database.pool.query<{
          ended_at: Date | null;
          user_id: string;
        }>('SELECT ended_at, user_id FROM memberships WHERE id = $1', [
          membershipA,
        ]);
        assert.ok(tenure.rows[0]?.ended_at);
        assert.equal(tenure.rows[0]?.user_id, userA);
        const taskKept = await database.pool.query<{
          completed_by_membership_id: string;
        }>(
          'SELECT completed_by_membership_id FROM task_instances WHERE id = $1',
          [completed.id],
        );
        assert.equal(taskKept.rows[0]?.completed_by_membership_id, membershipA);
        const authoredGone = await database.pool.query(
          'SELECT id FROM maintenance_entries WHERE id = $1',
          [authored.id],
        );
        assert.equal(authoredGone.rowCount, 0);

        const displays = await findHistoricalMembershipDisplays(database.pool, {
          homeId,
          membershipIds: [membershipA, membershipStay],
        });
        assert.equal(displays.get(membershipA)?.name, null);
        assert.equal(displays.get(membershipStay)?.name, 'Jamie Chen');

        const stayActivity = await listActivity({
          actor: actorStay,
          homeId,
        });
        const completion = stayActivity.items.find(
          (item) => item.sourceEntityId === completed.id,
        );
        assert.equal(completion?.actor?.membershipId, membershipA);
        assert.equal(completion?.actor?.name, null);
        assert.equal(
          stayActivity.items.some(
            (item) => item.sourceEntityId === authored.id,
          ),
          false,
        );

        const notes = await listNotifications({ userId: userStay });
        const completionNote = notes.items.find(
          (item) => item.kind === 'ASSIGNED_TASK_COMPLETED',
        );
        assert.ok(completionNote);
        assert.equal(completionNote.actor, null);

        const stayMaintenance = await listMaintenance({
          actor: actorStay,
          homeId,
        });
        assert.equal(
          stayMaintenance.items.some((item) => item.id === authored.id),
          false,
        );
        assert.equal(await resolver.resolve({ userId: userA, homeId }), null);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userA, userStay],
        });
        await database.close();
      }
    },
  );
});
