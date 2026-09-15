import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  DELETE_ATTRIBUTABLE_AUTH_VERIFICATIONS_SQL,
  createAuthIdentityTeardownPersistence,
} from '../../platform/auth/auth-identity-teardown.js';
import { createMembershipEndingWriter } from '../../domains/memberships/update-active-membership-ended-at.js';
import { outboxWriter } from '../../platform/events/outbox-writer.js';
import { systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { createEndMembershipWithinHomeStructure } from '../home-administration/end-membership-within-home-structure.js';
import { createMembershipEndingNotificationCleanupFromPool } from '../notifications/membership-ending-notification-cleanup.js';
import { createMembershipEndingSupplyCleanupFromPool } from '../supplies/membership-ending-supply-cleanup.js';
import { createMembershipEndingTaskCleanupFromPool } from '../tasks/membership-ending-task-cleanup.js';
import { createDeleteAccountLifecycleFromPool } from './delete-account-lifecycle.js';
import {
  cleanupLifecycle,
  insertAuthAccount,
  insertAuthSession,
  insertHome,
  insertInvitation,
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

type FailureFixture = {
  userId: string;
  email: string;
  adminUserId: string;
  homeId: string;
  membershipId: string;
  adminMembershipId: string;
};

async function seedFailureFixture(
  pool: ReturnType<typeof createDatabasePool>['pool'],
): Promise<FailureFixture> {
  const email = uniqueLifecycleEmail('m86-fail');
  const userId = await provisionCanonicalUser(pool, email);
  const adminUserId = randomUUID();
  const homeId = createUuidV7Home();
  const membershipId = createUuidV7Home();
  const adminMembershipId = createUuidV7Home();
  await insertAuthAccount(pool, userId);
  await insertAuthSession(pool, userId, `fail-session-${randomUUID()}`);
  await insertVerification(pool, { identifier: email, value: userId });
  await insertPlainUser(pool, adminUserId);
  await insertHome(pool, homeId, 'Failure lifecycle home');
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
  await insertManualTask(pool, {
    id: createUuidV7Home(),
    homeId,
    title: 'Assigned open task',
    assignedMembershipId: membershipId,
  });
  await insertSupplyWithClaim(pool, {
    entryId: createUuidV7Home(),
    claimId: createUuidV7Home(),
    homeId,
    createdByMembershipId: adminMembershipId,
    claimantMembershipId: membershipId,
  });
  await insertNotificationRow(
    pool,
    recipientNotification({
      homeId,
      recipientMembershipId: membershipId,
      actorMembershipId: adminMembershipId,
    }),
  );
  await insertMaintenanceEntry(pool, {
    id: createUuidV7Home(),
    homeId,
    createdByMembershipId: membershipId,
    visibility: 'HOUSEHOLD',
    title: 'Authored failure source',
  });
  await insertInvitation(pool, {
    id: createUuidV7Home(),
    homeId,
    invitedEmail: email,
    createdByMembershipId: adminMembershipId,
  });
  return {
    userId,
    email,
    adminUserId,
    homeId,
    membershipId,
    adminMembershipId,
  };
}

function createUuidV7Home(): string {
  return randomUUID();
}

function endMembershipWithCleanupHooks(
  pool: ReturnType<typeof createDatabasePool>['pool'],
  failAt: 'task' | 'supply' | null,
) {
  const task = createMembershipEndingTaskCleanupFromPool(pool);
  const supply = createMembershipEndingSupplyCleanupFromPool(pool);
  return createEndMembershipWithinHomeStructure({
    taskCleanup: {
      async handleMembershipEnded(tx, input) {
        await task.handleMembershipEnded(tx, input);
        if (failAt === 'task') {
          throw new Error('injected task cleanup failure');
        }
      },
    },
    supplyCleanup: {
      async handleMembershipEnded(tx, input) {
        await supply.handleMembershipEnded(tx, input);
        if (failAt === 'supply') {
          throw new Error('injected supply cleanup failure');
        }
      },
    },
    notificationCleanup:
      createMembershipEndingNotificationCleanupFromPool(pool),
    membershipEnding: createMembershipEndingWriter(),
    outbox: outboxWriter,
    ids: systemUuidV7,
  });
}

void describe('account deletion lifecycle atomicity', () => {
  for (const stage of [
    'preflight',
    'structural',
    'task',
    'supply',
    'maintenance',
    'invitations',
    'mark',
    'verification',
    'identity',
    'commit',
  ] as const) {
    void it(
      `rolls every lifecycle effect back when failure is injected ${stage}`,
      { skip: skipWithoutDatabase, timeout: 60_000 },
      async () => {
        const database = createDatabasePool(
          testConfig(resolveSafeDedicatedTestDatabaseUrl()),
        );
        const fixture = await seedFailureFixture(database.pool);
        const before = await snapshotLifecycle(database.pool, {
          userId: fixture.userId,
          homeIds: [fixture.homeId],
          membershipIds: [fixture.membershipId, fixture.adminMembershipId],
          email: fixture.email,
        });
        const realTeardown = createAuthIdentityTeardownPersistence();
        try {
          await assert.rejects(() =>
            createDeleteAccountLifecycleFromPool(database.pool, {
              clock: { now: () => LIFECYCLE_AT },
              endMembership: endMembershipWithCleanupHooks(
                database.pool,
                stage === 'task' || stage === 'supply' ? stage : null,
              ),
              eraseMaintenance:
                stage === 'maintenance'
                  ? () =>
                      Promise.reject(new Error('injected maintenance failure'))
                  : undefined,
              eraseInvitations:
                stage === 'invitations'
                  ? () =>
                      Promise.reject(new Error('injected invitation failure'))
                  : undefined,
              teardownAuth:
                stage === 'verification'
                  ? {
                      async teardownAuthForIdentity(tx, identity) {
                        await tx.query(
                          DELETE_ATTRIBUTABLE_AUTH_VERIFICATIONS_SQL,
                          [identity.userId, identity.email],
                        );
                        throw new Error('injected verification failure');
                      },
                    }
                  : stage === 'identity'
                    ? {
                        async teardownAuthForIdentity(tx, identity) {
                          await realTeardown.teardownAuthForIdentity(
                            tx,
                            identity,
                          );
                          throw new Error('injected identity failure');
                        },
                      }
                    : undefined,
              hooks: {
                afterGlobalPreflight: () =>
                  stage === 'preflight'
                    ? Promise.reject(new Error('injected preflight failure'))
                    : Promise.resolve(),
                afterFirstStructuralMutation: () =>
                  stage === 'structural'
                    ? Promise.reject(new Error('injected structural failure'))
                    : Promise.resolve(),
                afterUserDeletedAtMark: () =>
                  stage === 'mark'
                    ? Promise.reject(new Error('injected mark failure'))
                    : Promise.resolve(),
                beforeCommit: () =>
                  stage === 'commit'
                    ? Promise.reject(new Error('injected commit failure'))
                    : Promise.resolve(),
              },
            })({ userId: fixture.userId }),
          );
          const after = await snapshotLifecycle(database.pool, {
            userId: fixture.userId,
            homeIds: [fixture.homeId],
            membershipIds: [fixture.membershipId, fixture.adminMembershipId],
            email: fixture.email,
          });
          assert.deepEqual(after, before);
          assert.equal(after.userDeletedAt, null);
          assert.equal(after.identities, 1);
          assert.equal(after.accounts, 1);
          assert.equal(after.sessions, 1);
          assert.equal(after.verifications, 1);
          assert.equal(
            after.memberships.find((row) => row.id === fixture.membershipId)
              ?.endedAt,
            null,
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
  }
});
