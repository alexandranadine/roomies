import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { LastAdminRequiredError } from '../../domains/memberships/errors.js';
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { createDeleteAccountLifecycleFromPool } from './delete-account-lifecycle.js';
import {
  cleanupLifecycle,
  CREATED_AT,
  ENDED_AT,
  insertAuthAccount,
  insertAuthSession,
  insertHome,
  insertHomeVisibleActivity,
  insertInvitation,
  insertMaintenanceActivity,
  insertMaintenanceEntry,
  insertManualTask,
  insertMembership,
  insertNotificationRow,
  insertPlainUser,
  insertSupplyWithClaim,
  insertVerification,
  LIFECYCLE_AT,
  provisionCanonicalUser,
  recipientNotification,
  snapshotLifecycle,
  testConfig,
  uniqueLifecycleEmail,
} from './delete-account-lifecycle.test-helpers.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();

type LegalHome = {
  userId: string;
  email: string;
  adminUserId: string;
  homeId: string;
  membershipId: string;
  endedMembershipId: string;
  adminMembershipId: string;
  taskOpenId: string;
  taskCompletedId: string;
  supplyEntryId: string;
  supplyClaimId: string;
  authoredOpenId: string;
  authoredEndedId: string;
  audienceOnlyId: string;
  resolverOnlyId: string;
  recipientNotificationId: string;
  membershipActivityId: string;
  pendingInviteId: string;
  expiredInviteId: string;
  revokedInviteId: string;
  acceptedInviteId: string;
};

async function seedLegalRoommate(
  pool: ReturnType<typeof createDatabasePool>['pool'],
): Promise<LegalHome> {
  const email = uniqueLifecycleEmail('m86-legal');
  const userId = await provisionCanonicalUser(pool, email);
  const adminUserId = randomUUID();
  const homeId = createUuidV7();
  const membershipId = createUuidV7();
  const endedMembershipId = createUuidV7();
  const adminMembershipId = createUuidV7();
  await insertAuthAccount(pool, userId);
  await insertAuthSession(pool, userId, `session-${randomUUID()}`);
  await insertVerification(pool, { identifier: email, value: userId });
  await insertPlainUser(pool, adminUserId);
  await insertHome(pool, homeId, 'Legal roommate home');
  await insertMembership(pool, {
    id: endedMembershipId,
    homeId,
    userId,
    role: 'ROOMMATE',
    endedAt: ENDED_AT,
  });
  await insertMembership(pool, {
    id: membershipId,
    homeId,
    userId,
    role: 'ROOMMATE',
  });
  await insertMembership(pool, {
    id: adminMembershipId,
    homeId,
    userId: adminUserId,
    role: 'ADMIN',
  });

  const taskOpenId = createUuidV7();
  const taskCompletedId = createUuidV7();
  await insertManualTask(pool, {
    id: taskOpenId,
    homeId,
    title: 'Take out trash',
    assignedMembershipId: membershipId,
  });
  await insertManualTask(pool, {
    id: taskCompletedId,
    homeId,
    title: 'Finished chore',
    assignedMembershipId: membershipId,
    status: 'COMPLETED',
    completedByMembershipId: membershipId,
  });

  const supplyEntryId = createUuidV7();
  const supplyClaimId = createUuidV7();
  await insertSupplyWithClaim(pool, {
    entryId: supplyEntryId,
    claimId: supplyClaimId,
    homeId,
    createdByMembershipId: adminMembershipId,
    claimantMembershipId: membershipId,
  });

  const authoredOpenId = createUuidV7();
  const authoredEndedId = createUuidV7();
  const audienceOnlyId = createUuidV7();
  const resolverOnlyId = createUuidV7();
  await insertMaintenanceEntry(pool, {
    id: authoredOpenId,
    homeId,
    createdByMembershipId: membershipId,
    visibility: 'PRIVATE',
    title: 'Authored open leak',
    audienceMembershipIds: [membershipId, adminMembershipId],
  });
  await insertMaintenanceEntry(pool, {
    id: authoredEndedId,
    homeId,
    createdByMembershipId: endedMembershipId,
    visibility: 'HOUSEHOLD',
    title: 'Authored ended tenure',
  });
  await insertMaintenanceEntry(pool, {
    id: audienceOnlyId,
    homeId,
    createdByMembershipId: adminMembershipId,
    visibility: 'PRIVATE',
    title: 'Audience only',
    audienceMembershipIds: [membershipId, adminMembershipId],
  });
  await insertMaintenanceEntry(pool, {
    id: resolverOnlyId,
    homeId,
    createdByMembershipId: adminMembershipId,
    visibility: 'HOUSEHOLD',
    title: 'Resolver only',
    resolvedByMembershipId: membershipId,
    status: 'RESOLVED',
  });
  await insertMaintenanceActivity(pool, {
    homeId,
    sourceEntityId: authoredOpenId,
    visibility: 'PRIVATE',
    recipientMembershipIds: [membershipId, adminMembershipId],
    actorMembershipId: membershipId,
  });
  const membershipActivityId = await insertHomeVisibleActivity(pool, {
    homeId,
    sourceEntityType: 'MEMBERSHIP',
    sourceEntityId: membershipId,
    actorMembershipId: membershipId,
    eventType: 'membership.started.v1',
  });
  await insertHomeVisibleActivity(pool, {
    homeId,
    sourceEntityType: 'TASK',
    sourceEntityId: taskCompletedId,
    actorMembershipId: membershipId,
    eventType: 'task.completed.v1',
  });

  const recipient = recipientNotification({
    homeId,
    recipientMembershipId: membershipId,
    actorMembershipId: adminMembershipId,
  });
  await insertNotificationRow(pool, recipient);
  await insertNotificationRow(
    pool,
    recipientNotification({
      homeId,
      recipientMembershipId: adminMembershipId,
      sourceEntityType: 'MAINTENANCE',
      sourceEntityId: authoredOpenId,
      actorMembershipId: membershipId,
      kind: 'PRIVATE_MAINTENANCE_CREATED',
    }),
  );

  const pendingInviteId = createUuidV7();
  const expiredInviteId = createUuidV7();
  const revokedInviteId = createUuidV7();
  const acceptedInviteId = createUuidV7();
  await insertInvitation(pool, {
    id: acceptedInviteId,
    homeId,
    invitedEmail: email,
    createdByMembershipId: adminMembershipId,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    acceptedAt: new Date('2026-01-15T00:00:00.000Z'),
    acceptedMembershipId: endedMembershipId,
    expiresAt: new Date('2026-02-01T00:00:00.000Z'),
  });
  await insertInvitation(pool, {
    id: revokedInviteId,
    homeId,
    invitedEmail: email,
    createdByMembershipId: adminMembershipId,
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
    revokedAt: new Date('2026-02-15T00:00:00.000Z'),
    revocationCause: 'ADMIN_REVOKED',
    expiresAt: new Date('2026-03-01T00:00:00.000Z'),
  });
  await insertInvitation(pool, {
    id: expiredInviteId,
    homeId,
    invitedEmail: email,
    createdByMembershipId: adminMembershipId,
    createdAt: new Date('2026-03-01T00:00:00.000Z'),
    expiresAt: new Date('2026-03-15T00:00:00.000Z'),
  });
  await insertInvitation(pool, {
    id: pendingInviteId,
    homeId,
    invitedEmail: email,
    createdByMembershipId: adminMembershipId,
    createdAt: CREATED_AT,
    expiresAt: new Date('2026-12-01T00:00:00.000Z'),
  });
  await insertInvitation(pool, {
    id: createUuidV7(),
    homeId,
    invitedEmail: uniqueLifecycleEmail('m86-other-target'),
    createdByMembershipId: adminMembershipId,
  });

  return {
    userId,
    email,
    adminUserId,
    homeId,
    membershipId,
    endedMembershipId,
    adminMembershipId,
    taskOpenId,
    taskCompletedId,
    supplyEntryId,
    supplyClaimId,
    authoredOpenId,
    authoredEndedId,
    audienceOnlyId,
    resolverOnlyId,
    recipientNotificationId: recipient.id,
    membershipActivityId,
    pendingInviteId,
    expiredInviteId,
    revokedInviteId,
    acceptedInviteId,
  };
}

void describe('account deletion lifecycle PostgreSQL', () => {
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
    'ends an ordinary Membership, erases authored Maintenance and targeted invitations, and tears auth down last',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixture = await seedLegalRoommate(database.pool);
      const deleteAccount = createDeleteAccountLifecycleFromPool(
        database.pool,
        { clock: { now: () => LIFECYCLE_AT } },
      );
      try {
        const result = await deleteAccount({ userId: fixture.userId });
        assert.equal(result.outcome, 'completed');

        const snap = await snapshotLifecycle(database.pool, {
          userId: fixture.userId,
          homeIds: [fixture.homeId],
          membershipIds: [
            fixture.membershipId,
            fixture.endedMembershipId,
            fixture.adminMembershipId,
          ],
          email: fixture.email,
        });
        assert.equal(snap.homeArchived[0], null);
        assert.equal(
          snap.memberships
            .find((row) => row.id === fixture.membershipId)
            ?.endedAt?.getTime(),
          LIFECYCLE_AT.getTime(),
        );
        assert.equal(
          snap.memberships
            .find((row) => row.id === fixture.endedMembershipId)
            ?.endedAt?.getTime(),
          ENDED_AT.getTime(),
        );
        assert.equal(
          snap.memberships.find((row) => row.id === fixture.adminMembershipId)
            ?.endedAt,
          null,
        );
        assert.equal(
          snap.openTaskAssignments.includes(fixture.membershipId),
          false,
        );
        const completed = await database.pool.query<{
          assigned_membership_id: string | null;
        }>('SELECT assigned_membership_id FROM task_instances WHERE id = $1', [
          fixture.taskCompletedId,
        ]);
        assert.equal(
          completed.rows[0]?.assigned_membership_id,
          fixture.membershipId,
        );
        assert.equal(snap.activeClaims, 0);
        const claim = await database.pool.query<{
          claimant_membership_id: string;
          release_reason: string | null;
        }>(
          'SELECT claimant_membership_id, release_reason FROM supply_claims WHERE id = $1',
          [fixture.supplyClaimId],
        );
        assert.equal(
          claim.rows[0]?.claimant_membership_id,
          fixture.membershipId,
        );
        assert.equal(claim.rows[0]?.release_reason, 'MEMBERSHIP_ENDED');
        const recipient = await database.pool.query(
          'SELECT id FROM notifications WHERE id = $1',
          [fixture.recipientNotificationId],
        );
        assert.equal(recipient.rowCount, 0);
        const authored = await database.pool.query(
          'SELECT id FROM maintenance_entries WHERE id = ANY($1::uuid[])',
          [[fixture.authoredOpenId, fixture.authoredEndedId]],
        );
        assert.equal(authored.rowCount, 0);
        const retained = await database.pool.query<{ id: string }>(
          'SELECT id FROM maintenance_entries WHERE id = ANY($1::uuid[]) ORDER BY id',
          [[fixture.audienceOnlyId, fixture.resolverOnlyId]],
        );
        assert.equal(retained.rowCount, 2);
        const membershipActivity = await database.pool.query(
          'SELECT id FROM activities WHERE id = $1',
          [fixture.membershipActivityId],
        );
        assert.equal(membershipActivity.rowCount, 1);
        const targeted = await database.pool.query(
          'SELECT id FROM invitations WHERE invited_email = $1',
          [fixture.email],
        );
        assert.equal(targeted.rowCount, 0);
        const otherInvite = await database.pool.query(
          `SELECT id FROM invitations
           WHERE home_id = $1 AND invited_email <> $2`,
          [fixture.homeId, fixture.email],
        );
        assert.equal(otherInvite.rowCount, 1);
        assert.equal(snap.userDeletedAt?.getTime(), LIFECYCLE_AT.getTime());
        assert.equal(snap.identities, 0);
        assert.equal(snap.accounts, 0);
        assert.equal(snap.sessions, 0);
        assert.equal(snap.verifications, 0);
        assert.ok(snap.outboxTypes.includes('membership.ended.v1'));
        assert.equal(snap.outboxTypes.includes('account.deleted'), false);
        assert.equal(snap.outboxTypes.includes('home.archived.v1'), false);
      } finally {
        await cleanupLifecycle(database.pool, {
          homeIds: [fixture.homeId],
          userIds: [fixture.userId, fixture.adminUserId],
        });
        await database.close();
      }
    },
  );

  void it(
    'blocks sole-Admin deletion when another roommate remains',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const email = uniqueLifecycleEmail('m86-block');
      const userId = await provisionCanonicalUser(database.pool, email);
      const roommateUserId = randomUUID();
      const homeId = createUuidV7();
      const adminMembershipId = createUuidV7();
      const roommateMembershipId = createUuidV7();
      await insertAuthAccount(database.pool, userId);
      await insertPlainUser(database.pool, roommateUserId);
      await insertHome(database.pool, homeId, 'Blocked last admin');
      await insertMembership(database.pool, {
        id: adminMembershipId,
        homeId,
        userId,
        role: 'ADMIN',
      });
      await insertMembership(database.pool, {
        id: roommateMembershipId,
        homeId,
        userId: roommateUserId,
        role: 'ROOMMATE',
      });
      const before = await snapshotLifecycle(database.pool, {
        userId,
        homeIds: [homeId],
        membershipIds: [adminMembershipId, roommateMembershipId],
        email,
      });
      try {
        await assert.rejects(
          () => createDeleteAccountLifecycleFromPool(database.pool)({ userId }),
          LastAdminRequiredError,
        );
        const after = await snapshotLifecycle(database.pool, {
          userId,
          homeIds: [homeId],
          membershipIds: [adminMembershipId, roommateMembershipId],
          email,
        });
        assert.deepEqual(after, before);
      } finally {
        await cleanupLifecycle(database.pool, {
          homeIds: [homeId],
          userIds: [userId, roommateUserId],
        });
        await database.close();
      }
    },
  );

  void it(
    'archives the Home when the deleting User is the final active roommate',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const email = uniqueLifecycleEmail('m86-final');
      const userId = await provisionCanonicalUser(database.pool, email);
      const homeId = createUuidV7();
      const membershipId = createUuidV7();
      const pendingInviteId = createUuidV7();
      await insertAuthAccount(database.pool, userId);
      await insertHome(database.pool, homeId, 'Final member home');
      await insertMembership(database.pool, {
        id: membershipId,
        homeId,
        userId,
        role: 'ADMIN',
      });
      await insertInvitation(database.pool, {
        id: pendingInviteId,
        homeId,
        invitedEmail: uniqueLifecycleEmail('m86-final-pending'),
        createdByMembershipId: membershipId,
      });
      try {
        const result = await createDeleteAccountLifecycleFromPool(
          database.pool,
          { clock: { now: () => LIFECYCLE_AT } },
        )({ userId });
        assert.equal(result.outcome, 'completed');
        const home = await database.pool.query<{ archived_at: Date | null }>(
          'SELECT archived_at FROM homes WHERE id = $1',
          [homeId],
        );
        const membership = await database.pool.query<{ ended_at: Date | null }>(
          'SELECT ended_at FROM memberships WHERE id = $1',
          [membershipId],
        );
        const invitation = await database.pool.query<{
          revoked_at: Date | null;
          revocation_cause: string | null;
        }>(
          'SELECT revoked_at, revocation_cause FROM invitations WHERE id = $1',
          [pendingInviteId],
        );
        const outbox = await database.pool.query<{ event_type: string }>(
          `SELECT event_type FROM outbox_events
           WHERE home_id = $1 ORDER BY created_at, event_id`,
          [homeId],
        );
        assert.equal(
          home.rows[0]?.archived_at?.getTime(),
          LIFECYCLE_AT.getTime(),
        );
        assert.equal(
          membership.rows[0]?.ended_at?.getTime(),
          LIFECYCLE_AT.getTime(),
        );
        assert.equal(
          invitation.rows[0]?.revoked_at?.getTime(),
          LIFECYCLE_AT.getTime(),
        );
        assert.equal(invitation.rows[0]?.revocation_cause, 'HOME_ARCHIVED');
        assert.deepEqual(
          outbox.rows.map((row) => row.event_type),
          ['membership.ended.v1', 'home.archived.v1'],
        );
      } finally {
        await cleanupLifecycle(database.pool, {
          homeIds: [homeId],
          userIds: [userId],
        });
        await database.close();
      }
    },
  );

  void it(
    'applies legal decisions across multiple Homes and rolls none of them back when one Home is blocked',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const legalEmail = uniqueLifecycleEmail('m86-multi-ok');
      const blockedEmail = uniqueLifecycleEmail('m86-multi-block');
      const legalUser = await provisionCanonicalUser(database.pool, legalEmail);
      const blockedUser = await provisionCanonicalUser(
        database.pool,
        blockedEmail,
      );
      const roommateA = randomUUID();
      const roommateB = randomUUID();
      const homeA = createUuidV7();
      const homeB = createUuidV7();
      const legalA = createUuidV7();
      const legalB = createUuidV7();
      const blockedA = createUuidV7();
      const blockedB = createUuidV7();
      const adminA = createUuidV7();
      const roommateMembershipB = createUuidV7();
      await insertAuthAccount(database.pool, legalUser);
      await insertAuthAccount(database.pool, blockedUser);
      await insertPlainUser(database.pool, roommateA);
      await insertPlainUser(database.pool, roommateB);
      await insertHome(database.pool, homeA, 'Multi A');
      await insertHome(database.pool, homeB, 'Multi B');
      await insertMembership(database.pool, {
        id: legalA,
        homeId: homeA,
        userId: legalUser,
        role: 'ROOMMATE',
      });
      await insertMembership(database.pool, {
        id: adminA,
        homeId: homeA,
        userId: roommateA,
        role: 'ADMIN',
      });
      await insertMembership(database.pool, {
        id: legalB,
        homeId: homeB,
        userId: legalUser,
        role: 'ROOMMATE',
      });
      await insertMembership(database.pool, {
        id: roommateMembershipB,
        homeId: homeB,
        userId: roommateB,
        role: 'ROOMMATE',
      });
      await insertMembership(database.pool, {
        id: blockedA,
        homeId: homeA,
        userId: blockedUser,
        role: 'ROOMMATE',
      });
      await insertMembership(database.pool, {
        id: blockedB,
        homeId: homeB,
        userId: blockedUser,
        role: 'ADMIN',
      });
      try {
        const legal = await createDeleteAccountLifecycleFromPool(
          database.pool,
          { clock: { now: () => LIFECYCLE_AT } },
        )({ userId: legalUser });
        assert.equal(legal.outcome, 'completed');
        const legalMemberships = await database.pool.query<{
          ended_at: Date | null;
        }>('SELECT ended_at FROM memberships WHERE id = ANY($1::uuid[])', [
          [legalA, legalB],
        ]);
        assert.equal(legalMemberships.rows.length, 2);
        assert.ok(
          legalMemberships.rows.every(
            (row) => row.ended_at?.getTime() === LIFECYCLE_AT.getTime(),
          ),
        );

        const beforeBlocked = await snapshotLifecycle(database.pool, {
          userId: blockedUser,
          homeIds: [homeA, homeB],
          membershipIds: [blockedA, blockedB, adminA, roommateMembershipB],
          email: blockedEmail,
        });
        await assert.rejects(
          () =>
            createDeleteAccountLifecycleFromPool(database.pool)({
              userId: blockedUser,
            }),
          LastAdminRequiredError,
        );
        const afterBlocked = await snapshotLifecycle(database.pool, {
          userId: blockedUser,
          homeIds: [homeA, homeB],
          membershipIds: [blockedA, blockedB, adminA, roommateMembershipB],
          email: blockedEmail,
        });
        assert.deepEqual(afterBlocked, beforeBlocked);
        assert.equal(afterBlocked.userDeletedAt, null);
        assert.equal(
          afterBlocked.memberships.find((row) => row.id === blockedA)?.endedAt,
          null,
        );
        assert.equal(
          afterBlocked.memberships.find((row) => row.id === blockedB)?.endedAt,
          null,
        );
      } finally {
        await cleanupLifecycle(database.pool, {
          homeIds: [homeA, homeB],
          userIds: [legalUser, blockedUser, roommateA, roommateB],
        });
        await database.close();
      }
    },
  );

  void it(
    'erases authored sources from ended and rejoin tenures without collapsing history',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const email = uniqueLifecycleEmail('m86-rejoin');
      const userId = await provisionCanonicalUser(database.pool, email);
      const adminUserId = randomUUID();
      const homeId = createUuidV7();
      const endedId = createUuidV7();
      const activeId = createUuidV7();
      const adminId = createUuidV7();
      const endedEntry = createUuidV7();
      const activeEntry = createUuidV7();
      await insertAuthAccount(database.pool, userId);
      await insertPlainUser(database.pool, adminUserId);
      await insertHome(database.pool, homeId, 'Rejoin home');
      await insertMembership(database.pool, {
        id: endedId,
        homeId,
        userId,
        role: 'ROOMMATE',
        endedAt: ENDED_AT,
      });
      await insertMembership(database.pool, {
        id: activeId,
        homeId,
        userId,
        role: 'ROOMMATE',
      });
      await insertMembership(database.pool, {
        id: adminId,
        homeId,
        userId: adminUserId,
        role: 'ADMIN',
      });
      await insertMaintenanceEntry(database.pool, {
        id: endedEntry,
        homeId,
        createdByMembershipId: endedId,
        visibility: 'HOUSEHOLD',
        title: 'Ended tenure source',
      });
      await insertMaintenanceEntry(database.pool, {
        id: activeEntry,
        homeId,
        createdByMembershipId: activeId,
        visibility: 'PRIVATE',
        title: 'Rejoin source',
        audienceMembershipIds: [activeId, adminId],
      });
      try {
        await createDeleteAccountLifecycleFromPool(database.pool, {
          clock: { now: () => LIFECYCLE_AT },
        })({ userId });
        const remaining = await database.pool.query(
          'SELECT id FROM maintenance_entries WHERE id = ANY($1::uuid[])',
          [[endedEntry, activeEntry]],
        );
        const tenures = await database.pool.query<{
          id: string;
          ended_at: Date | null;
        }>(
          'SELECT id, ended_at FROM memberships WHERE id = ANY($1::uuid[]) ORDER BY id',
          [[endedId, activeId]],
        );
        assert.equal(remaining.rowCount, 0);
        assert.equal(tenures.rowCount, 2);
        assert.equal(
          tenures.rows.find((row) => row.id === endedId)?.ended_at?.getTime(),
          ENDED_AT.getTime(),
        );
        assert.equal(
          tenures.rows.find((row) => row.id === activeId)?.ended_at?.getTime(),
          LIFECYCLE_AT.getTime(),
        );
      } finally {
        await cleanupLifecycle(database.pool, {
          homeIds: [homeId],
          userIds: [userId, adminUserId],
        });
        await database.close();
      }
    },
  );

  void it(
    'deletes a User with only ended tenures or no Memberships without structural mutation',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const endedEmail = uniqueLifecycleEmail('m86-ended-only');
      const emptyEmail = uniqueLifecycleEmail('m86-empty');
      const endedUser = await provisionCanonicalUser(database.pool, endedEmail);
      const emptyUser = await provisionCanonicalUser(database.pool, emptyEmail);
      const otherUser = randomUUID();
      const homeId = createUuidV7();
      const endedMembership = createUuidV7();
      const otherMembership = createUuidV7();
      await insertAuthAccount(database.pool, endedUser);
      await insertAuthAccount(database.pool, emptyUser);
      await insertPlainUser(database.pool, otherUser);
      await insertHome(database.pool, homeId, 'Historical only', ENDED_AT);
      await insertMembership(database.pool, {
        id: endedMembership,
        homeId,
        userId: endedUser,
        role: 'ROOMMATE',
        endedAt: ENDED_AT,
      });
      await insertMembership(database.pool, {
        id: otherMembership,
        homeId,
        userId: otherUser,
        role: 'ADMIN',
        endedAt: ENDED_AT,
      });
      try {
        const endedResult = await createDeleteAccountLifecycleFromPool(
          database.pool,
          { clock: { now: () => LIFECYCLE_AT } },
        )({ userId: endedUser });
        const emptyResult = await createDeleteAccountLifecycleFromPool(
          database.pool,
          { clock: { now: () => LIFECYCLE_AT } },
        )({ userId: emptyUser });
        assert.equal(endedResult.outcome, 'completed');
        assert.equal(emptyResult.outcome, 'completed');
        const home = await database.pool.query<{ archived_at: Date | null }>(
          'SELECT archived_at FROM homes WHERE id = $1',
          [homeId],
        );
        const membership = await database.pool.query<{ ended_at: Date | null }>(
          'SELECT ended_at FROM memberships WHERE id = $1',
          [endedMembership],
        );
        const users = await database.pool.query<{ deleted_at: Date | null }>(
          'SELECT deleted_at FROM users WHERE id = ANY($1::uuid[])',
          [[endedUser, emptyUser]],
        );
        assert.equal(home.rows[0]?.archived_at?.getTime(), ENDED_AT.getTime());
        assert.equal(
          membership.rows[0]?.ended_at?.getTime(),
          ENDED_AT.getTime(),
        );
        assert.ok(
          users.rows.every(
            (row) => row.deleted_at?.getTime() === LIFECYCLE_AT.getTime(),
          ),
        );
      } finally {
        await cleanupLifecycle(database.pool, {
          homeIds: [homeId],
          userIds: [endedUser, emptyUser, otherUser],
        });
        await database.close();
      }
    },
  );

  void it(
    'returns already_deleted without repeating cleanup or emitting events',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixture = await seedLegalRoommate(database.pool);
      const deleteAccount = createDeleteAccountLifecycleFromPool(
        database.pool,
        { clock: { now: () => LIFECYCLE_AT } },
      );
      try {
        await deleteAccount({ userId: fixture.userId });
        const afterFirst = await snapshotLifecycle(database.pool, {
          userId: fixture.userId,
          homeIds: [fixture.homeId],
          membershipIds: [fixture.membershipId, fixture.endedMembershipId],
          email: fixture.email,
        });
        const second = await deleteAccount({ userId: fixture.userId });
        assert.equal(second.outcome, 'already_deleted');
        const afterSecond = await snapshotLifecycle(database.pool, {
          userId: fixture.userId,
          homeIds: [fixture.homeId],
          membershipIds: [fixture.membershipId, fixture.endedMembershipId],
          email: fixture.email,
        });
        assert.deepEqual(afterSecond, afterFirst);
        assert.equal(
          afterSecond.outboxTypes.filter(
            (type) => type === 'membership.ended.v1',
          ).length,
          1,
        );
      } finally {
        await cleanupLifecycle(database.pool, {
          homeIds: [fixture.homeId],
          userIds: [fixture.userId, fixture.adminUserId],
        });
        await database.close();
      }
    },
  );

  void it(
    'records User then sorted Home locks before feature cleanup',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const email = uniqueLifecycleEmail('m86-locks');
      const userId = await provisionCanonicalUser(database.pool, email);
      const adminUserId = randomUUID();
      const homeB = createUuidV7();
      const homeA = createUuidV7();
      const [firstHome, secondHome] = [homeA, homeB].sort();
      await insertAuthAccount(database.pool, userId);
      await insertPlainUser(database.pool, adminUserId);
      await insertHome(database.pool, homeA, 'Lock A');
      await insertHome(database.pool, homeB, 'Lock B');
      await insertMembership(database.pool, {
        id: createUuidV7(),
        homeId: homeA,
        userId,
        role: 'ROOMMATE',
      });
      await insertMembership(database.pool, {
        id: createUuidV7(),
        homeId: homeA,
        userId: adminUserId,
        role: 'ADMIN',
      });
      await insertMembership(database.pool, {
        id: createUuidV7(),
        homeId: homeB,
        userId,
        role: 'ROOMMATE',
      });
      await insertMembership(database.pool, {
        id: createUuidV7(),
        homeId: homeB,
        userId: adminUserId,
        role: 'ADMIN',
      });
      const stages: string[] = [];
      try {
        await createDeleteAccountLifecycleFromPool(database.pool, {
          hooks: {
            afterUserLocked: () => {
              stages.push('user');
              return Promise.resolve();
            },
            afterTenuresDiscovered: () => {
              stages.push('tenures');
              return Promise.resolve();
            },
            afterHomesLocked: () => {
              stages.push(`homes:${firstHome},${secondHome}`);
              return Promise.resolve();
            },
            afterGlobalPreflight: () => {
              stages.push('preflight');
              return Promise.resolve();
            },
            afterFirstStructuralMutation: () => {
              stages.push('structural');
              return Promise.resolve();
            },
            afterMaintenanceErasure: () => {
              stages.push('maintenance');
              return Promise.resolve();
            },
            afterInvitationErasure: () => {
              stages.push('invitations');
              return Promise.resolve();
            },
            afterUserDeletedAtMark: () => {
              stages.push('user-deleted');
              return Promise.resolve();
            },
            afterAuthTeardown: () => {
              stages.push('auth');
              return Promise.resolve();
            },
          },
        })({ userId });
        assert.deepEqual(stages, [
          'user',
          'tenures',
          `homes:${firstHome},${secondHome}`,
          'preflight',
          'structural',
          'maintenance',
          'invitations',
          'user-deleted',
          'auth',
        ]);
      } finally {
        await cleanupLifecycle(database.pool, {
          homeIds: [homeA, homeB],
          userIds: [userId, adminUserId],
        });
        await database.close();
      }
    },
  );
});
