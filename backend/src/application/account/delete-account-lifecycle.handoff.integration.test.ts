import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { createActivityOutboxHandlerFromPool } from '../activity/outbox-handler.js';
import { createListHomeActivityFromPool } from '../activity/list-home-activity.js';
import { createListHomeMaintenanceFromPool } from '../maintenance/list-home-maintenance.js';
import { createCreateMaintenanceEntryFromPool } from '../maintenance/create-maintenance-entry.js';
import { createListCurrentUserNotificationsFromPool } from '../notifications/list-current-user-notifications.js';
import { createNotificationOutboxHandlerFromPool } from '../notifications/outbox-handler.js';
import { createGetHousePulseFromPool } from '../pulse/get-house-pulse.js';
import {
  createActiveHomesForUserReader,
  listActiveHomesForUser,
} from '../../domains/homes/index.js';
import { createApp } from '../../platform/http/create-app.js';
import { withAppServer } from '../../platform/http/app-request.test-helper.js';
import { createAuthRuntime } from '../../platform/auth/runtime.js';
import { createDbReadiness } from '../../platform/persistence/readiness.js';
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
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createDb } from '../../prisma/db.js';
import { createDeleteAccountLifecycleFromPool } from './delete-account-lifecycle.js';
import {
  cleanupLifecycle,
  ENDED_AT,
  insertHome,
  insertInvitation,
  insertMaintenanceActivity,
  insertMaintenanceEntry,
  insertMembership,
  insertNotificationRow,
  insertPlainUser,
  LIFECYCLE_AT,
  recipientNotification,
  testConfig,
} from './delete-account-lifecycle.test-helpers.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const PASSWORD = 'test-password-only';
const TRUSTED_ORIGIN = 'http://localhost:5173';

const silentLogger = {
  info() {},
  error() {},
};

function actor(input: {
  userId: string;
  membershipId: string;
  homeId: string;
  role: 'ADMIN' | 'ROOMMATE';
}) {
  return input;
}

function findSessionSetCookie(headers: Headers): string | undefined {
  return headers
    .getSetCookie()
    .find((cookie) => /session_token=/i.test(cookie.split(';', 1)[0] ?? ''));
}

function maintenancePulseCount(
  pulse: Awaited<ReturnType<ReturnType<typeof createGetHousePulseFromPool>>>,
): number {
  const section = pulse.items.find((item) => item.type === 'MAINTENANCE');
  assert.ok(section);
  return section.openVisibleCount;
}

void describe('account deletion M8.9 handoff PostgreSQL', () => {
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
    'erases the private sentinel, drains leftover outbox safely, and isolates same-email re-signup',
    { skip: skipWithoutDatabase, timeout: 90_000 },
    async () => {
      const databaseUrl = resolveSafeDedicatedTestDatabaseUrl();
      const config = testConfig(databaseUrl);
      const database = createDatabasePool(config);
      const db = createDb(database.pool);
      const auth = createAuthRuntime(database.pool, config);
      const homeId = createUuidV7();
      const endedMembershipId = createUuidV7();
      const alexMembershipId = createUuidV7();
      const jamieMembershipId = createUuidV7();
      const taylorMembershipId = createUuidV7();
      const jamieUserId = randomUUID();
      const taylorUserId = randomUUID();
      const endedAuthoredId = createUuidV7();
      const jamieAudienceOnlyId = createUuidV7();
      const jamieResolverOnlyId = createUuidV7();
      const pendingInviteId = createUuidV7();
      const acceptedInviteId = createUuidV7();
      const identityIds: string[] = [];

      try {
        await db.connect();
        await insertPlainUser(database.pool, jamieUserId);
        await insertPlainUser(database.pool, taylorUserId);
        const app = createApp({
          config,
          readiness: createDbReadiness(db),
          auth,
        });

        await withAppServer(app, async (request) => {
          const email = `m89-alex-${randomUUID()}@example.test`;
          const signup = await request({
            method: 'POST',
            path: '/api/auth/sign-up/email',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              name: 'Alex',
              email,
              password: PASSWORD,
            }),
          });
          assert.ok(signup.status >= 200 && signup.status < 300);
          const alexUserId = (signup.json() as { user?: { id?: string } }).user
            ?.id;
          assert.ok(alexUserId);
          identityIds.push(alexUserId);
          assert.ok(findSessionSetCookie(signup.headers));

          const genericDelete = await request({
            method: 'POST',
            path: '/api/auth/delete-user',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({}),
          });
          assert.notEqual(genericDelete.status, 200);
          assert.notEqual(genericDelete.status, 204);
          const stillPresent = await database.pool.query(
            'SELECT id FROM auth_identities WHERE id = $1',
            [alexUserId],
          );
          assert.equal(stillPresent.rowCount, 1);

          await insertHome(database.pool, homeId, 'M8.9 sentinel home');
          await insertMembership(database.pool, {
            id: endedMembershipId,
            homeId,
            userId: alexUserId,
            role: 'ROOMMATE',
            endedAt: ENDED_AT,
          });
          await insertMembership(database.pool, {
            id: alexMembershipId,
            homeId,
            userId: alexUserId,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: jamieMembershipId,
            homeId,
            userId: jamieUserId,
            role: 'ROOMMATE',
          });
          await insertMembership(database.pool, {
            id: taylorMembershipId,
            homeId,
            userId: taylorUserId,
            role: 'ADMIN',
          });

          await insertMaintenanceEntry(database.pool, {
            id: endedAuthoredId,
            homeId,
            createdByMembershipId: endedMembershipId,
            visibility: 'HOUSEHOLD',
            title: 'Ended tenure authored leak',
          });
          const alexPrivate = await createCreateMaintenanceEntryFromPool(
            database.pool,
          )({
            actor: actor({
              userId: alexUserId,
              membershipId: alexMembershipId,
              homeId,
              role: 'ROOMMATE',
            }),
            homeId,
            visibility: 'PRIVATE',
            title: 'Alex private leak',
            audienceMembershipIds: [alexMembershipId, jamieMembershipId],
          });
          await insertMaintenanceEntry(database.pool, {
            id: jamieAudienceOnlyId,
            homeId,
            createdByMembershipId: jamieMembershipId,
            visibility: 'PRIVATE',
            title: 'Jamie audience only',
            audienceMembershipIds: [jamieMembershipId, alexMembershipId],
          });
          await insertMaintenanceEntry(database.pool, {
            id: jamieResolverOnlyId,
            homeId,
            createdByMembershipId: jamieMembershipId,
            visibility: 'HOUSEHOLD',
            title: 'Jamie resolver only',
            resolvedByMembershipId: alexMembershipId,
            status: 'RESOLVED',
          });
          await insertMaintenanceActivity(database.pool, {
            homeId,
            sourceEntityId: alexPrivate.id,
            visibility: 'PRIVATE',
            recipientMembershipIds: [alexMembershipId, jamieMembershipId],
            actorMembershipId: alexMembershipId,
          });
          await insertNotificationRow(
            database.pool,
            recipientNotification({
              homeId,
              recipientMembershipId: jamieMembershipId,
              sourceEntityType: 'MAINTENANCE',
              sourceEntityId: alexPrivate.id,
              actorMembershipId: alexMembershipId,
              kind: 'PRIVATE_MAINTENANCE_CREATED',
            }),
          );
          await insertInvitation(database.pool, {
            id: acceptedInviteId,
            homeId,
            invitedEmail: email,
            createdByMembershipId: taylorMembershipId,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            acceptedAt: new Date('2026-01-15T00:00:00.000Z'),
            acceptedMembershipId: endedMembershipId,
            expiresAt: new Date('2026-02-01T00:00:00.000Z'),
          });
          await insertInvitation(database.pool, {
            id: pendingInviteId,
            homeId,
            invitedEmail: email,
            createdByMembershipId: taylorMembershipId,
          });

          const pendingOutbox = await database.pool.query<{
            event_type: string;
            payload: { maintenanceEntryId?: string };
            processed_at: Date | null;
          }>(
            `SELECT event_type, payload, processed_at
             FROM outbox_events
             WHERE home_id = $1 AND event_type = 'maintenance.created.v1'
             ORDER BY created_at ASC`,
            [homeId],
          );
          assert.ok(
            pendingOutbox.rows.some((row) => row.processed_at === null),
          );
          const leftover = pendingOutbox.rows.find(
            (row) => row.payload.maintenanceEntryId === alexPrivate.id,
          );
          assert.ok(leftover);
          const leftoverJson = JSON.stringify(leftover.payload);
          assert.doesNotMatch(leftoverJson, /Alex private leak/);
          assert.doesNotMatch(leftoverJson, /audience/);
          assert.doesNotMatch(leftoverJson, /@example\.test/);

          const result = await createDeleteAccountLifecycleFromPool(
            database.pool,
            { clock: { now: () => LIFECYCLE_AT } },
          )({ userId: alexUserId });
          assert.equal(result.outcome, 'completed');

          const authored = await database.pool.query(
            'SELECT id FROM maintenance_entries WHERE id = ANY($1::uuid[])',
            [[alexPrivate.id, endedAuthoredId]],
          );
          assert.equal(authored.rowCount, 0);
          const audience = await database.pool.query(
            `SELECT membership_id FROM maintenance_audiences
             WHERE maintenance_entry_id = $1`,
            [alexPrivate.id],
          );
          assert.equal(audience.rowCount, 0);
          const retained = await database.pool.query<{ id: string }>(
            'SELECT id FROM maintenance_entries WHERE id = ANY($1::uuid[])',
            [[jamieAudienceOnlyId, jamieResolverOnlyId]],
          );
          assert.equal(retained.rowCount, 2);
          const tenures = await database.pool.query<{
            id: string;
            user_id: string;
            ended_at: Date | null;
          }>(
            `SELECT id, user_id, ended_at FROM memberships
             WHERE id = ANY($1::uuid[]) ORDER BY id`,
            [[endedMembershipId, alexMembershipId]],
          );
          assert.equal(tenures.rowCount, 2);
          assert.ok(tenures.rows.every((row) => row.user_id === alexUserId));
          assert.equal(
            tenures.rows
              .find((row) => row.id === endedMembershipId)
              ?.ended_at?.getTime(),
            ENDED_AT.getTime(),
          );
          assert.equal(
            tenures.rows
              .find((row) => row.id === alexMembershipId)
              ?.ended_at?.getTime(),
            LIFECYCLE_AT.getTime(),
          );

          const oldUser = await database.pool.query<{
            deleted_at: Date | null;
          }>('SELECT deleted_at FROM users WHERE id = $1', [alexUserId]);
          assert.equal(
            oldUser.rows[0]?.deleted_at?.getTime(),
            LIFECYCLE_AT.getTime(),
          );
          const identities = await database.pool.query(
            'SELECT id FROM auth_identities WHERE id = $1',
            [alexUserId],
          );
          assert.equal(identities.rowCount, 0);
          const targeted = await database.pool.query(
            'SELECT id FROM invitations WHERE invited_email = $1',
            [email],
          );
          assert.equal(targeted.rowCount, 0);

          await createOutboxConsumerFromPool(database.pool, {
            registry: createOutboxHandlerRegistry([
              createActivityOutboxHandlerFromPool(database.pool),
              createNotificationOutboxHandlerFromPool(database.pool),
            ]),
            logger: silentLogger,
          }).drain({ batchSize: 20 });

          const resurrectedActivity = await database.pool.query(
            `SELECT id FROM activities
             WHERE home_id = $1 AND source_entity_type = 'MAINTENANCE'
               AND source_entity_id = $2`,
            [homeId, alexPrivate.id],
          );
          const resurrectedNotifications = await database.pool.query(
            `SELECT id FROM notifications
             WHERE home_id = $1 AND source_entity_type = 'MAINTENANCE'
               AND source_entity_id = $2`,
            [homeId, alexPrivate.id],
          );
          assert.equal(resurrectedActivity.rowCount, 0);
          assert.equal(resurrectedNotifications.rowCount, 0);
          const processed = await database.pool.query<{
            processed_at: Date | null;
            event_type: string;
          }>(
            `SELECT processed_at, event_type FROM outbox_events
             WHERE home_id = $1`,
            [homeId],
          );
          assert.ok(
            processed.rows.every((row) => row.processed_at instanceof Date),
          );
          assert.ok(
            processed.rows.some(
              (row) => row.event_type === 'membership.ended.v1',
            ),
          );
          assert.equal(
            processed.rows.some((row) => row.event_type === 'account.deleted'),
            false,
          );

          const listMaintenance = createListHomeMaintenanceFromPool(
            database.pool,
          );
          const listActivity = createListHomeActivityFromPool(database.pool);
          const listNotifications = createListCurrentUserNotificationsFromPool(
            database.pool,
          );
          const getPulse = createGetHousePulseFromPool(database.pool);
          const jamieActor = actor({
            userId: jamieUserId,
            membershipId: jamieMembershipId,
            homeId,
            role: 'ROOMMATE',
          });
          const taylorActor = actor({
            userId: taylorUserId,
            membershipId: taylorMembershipId,
            homeId,
            role: 'ADMIN',
          });

          const jamieList = await listMaintenance({
            actor: jamieActor,
            homeId,
          });
          const taylorList = await listMaintenance({
            actor: taylorActor,
            homeId,
          });
          assert.equal(
            jamieList.items.some((item) => item.id === alexPrivate.id),
            false,
          );
          assert.equal(
            taylorList.items.some((item) => item.id === alexPrivate.id),
            false,
          );
          assert.ok(
            jamieList.items.some((item) => item.id === jamieAudienceOnlyId),
          );
          assert.ok(
            jamieList.items.some((item) => item.id === jamieResolverOnlyId),
          );
          assert.equal(
            taylorList.items.some((item) => item.id === jamieAudienceOnlyId),
            false,
          );
          assert.ok(
            taylorList.items.some((item) => item.id === jamieResolverOnlyId),
          );

          const jamieActivity = await listActivity({
            actor: jamieActor,
            homeId,
          });
          const taylorActivity = await listActivity({
            actor: taylorActor,
            homeId,
          });
          assert.equal(
            jamieActivity.items.some(
              (item) => item.sourceEntityId === alexPrivate.id,
            ),
            false,
          );
          assert.equal(
            taylorActivity.items.some(
              (item) => item.sourceEntityId === alexPrivate.id,
            ),
            false,
          );

          const jamieNotes = await listNotifications({ userId: jamieUserId });
          const taylorNotes = await listNotifications({ userId: taylorUserId });
          assert.equal(
            jamieNotes.items.some(
              (item) => item.kind === 'PRIVATE_MAINTENANCE_CREATED',
            ),
            false,
          );
          assert.equal(
            taylorNotes.items.some(
              (item) => item.kind === 'PRIVATE_MAINTENANCE_CREATED',
            ),
            false,
          );
          assert.equal(
            maintenancePulseCount(
              await getPulse({ actor: jamieActor, homeId }),
            ),
            1,
          );
          assert.equal(
            maintenancePulseCount(
              await getPulse({ actor: taylorActor, homeId }),
            ),
            0,
          );

          const resignup = await request({
            method: 'POST',
            path: '/api/auth/sign-up/email',
            headers: {
              Origin: TRUSTED_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              name: 'Alex',
              email,
              password: PASSWORD,
            }),
          });
          assert.ok(resignup.status >= 200 && resignup.status < 300);
          const newUserId = (resignup.json() as { user?: { id?: string } }).user
            ?.id;
          assert.ok(newUserId);
          identityIds.push(newUserId);
          assert.notEqual(newUserId, alexUserId);

          const stillDeleted = await database.pool.query<{
            deleted_at: Date | null;
          }>('SELECT deleted_at FROM users WHERE id = $1', [alexUserId]);
          assert.ok(stillDeleted.rows[0]?.deleted_at);
          const newIdentity = await database.pool.query<{ id: string }>(
            'SELECT id::text AS id FROM auth_identities WHERE id = $1',
            [newUserId],
          );
          assert.equal(newIdentity.rows[0]?.id, newUserId);
          const inheritedMemberships = await database.pool.query(
            'SELECT id FROM memberships WHERE user_id = $1',
            [newUserId],
          );
          assert.equal(inheritedMemberships.rowCount, 0);
          const oldMemberships = await database.pool.query(
            'SELECT id FROM memberships WHERE user_id = $1',
            [alexUserId],
          );
          assert.equal(oldMemberships.rowCount, 2);
          const homes = await listActiveHomesForUser(
            { userId: newUserId },
            createActiveHomesForUserReader(database.pool),
          );
          assert.equal(homes.length, 0);
          const newNotes = await listNotifications({ userId: newUserId });
          assert.equal(newNotes.items.length, 0);
          const newRecipients = await database.pool.query(
            `SELECT ar.activity_id
             FROM activity_recipients AS ar
             JOIN memberships AS m ON m.id = ar.membership_id
             WHERE m.user_id = $1`,
            [newUserId],
          );
          assert.equal(newRecipients.rowCount, 0);
          const leftoverInvites = await database.pool.query(
            'SELECT id FROM invitations WHERE invited_email = $1',
            [email],
          );
          assert.equal(leftoverInvites.rowCount, 0);
        });
      } finally {
        await cleanupLifecycle(database.pool, {
          homeIds: [homeId],
          userIds: [...identityIds, jamieUserId, taylorUserId],
        });
        await db.close();
        await database.close();
      }
    },
  );
});
