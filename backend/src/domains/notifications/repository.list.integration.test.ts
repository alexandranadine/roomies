import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createMaintenanceRepository } from '../maintenance/repository.js';
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import type { AppConfig } from '../../platform/config/types.js';
import { NOTIFICATION_KIND_SOURCE_TYPE } from './notification.js';
import {
  bindNotificationListCursor,
  encodeNotificationListCursor,
  NOTIFICATION_LIST_QUERY_FINGERPRINT,
} from './cursor.js';
import { InvalidNotificationRequestError } from './errors.js';
import {
  createNotificationRepository,
  type NewNotification,
} from './repository.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const CREATED = new Date('2026-09-13T12:00:00.000Z');

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

function row(
  homeId: string,
  recipientMembershipId: string,
  overrides: Partial<NewNotification> = {},
): NewNotification {
  const kind = overrides.kind ?? 'ASSIGNED_TASK_COMPLETED';
  return {
    id: overrides.id ?? createUuidV7(),
    homeId,
    recipientMembershipId,
    sourceOutboxEventId: overrides.sourceOutboxEventId ?? createUuidV7(),
    kind,
    sourceEntityType:
      overrides.sourceEntityType ?? NOTIFICATION_KIND_SOURCE_TYPE[kind],
    sourceEntityId: overrides.sourceEntityId ?? createUuidV7(),
    actorMembershipId:
      overrides.actorMembershipId === undefined
        ? null
        : overrides.actorMembershipId,
    occurredAt: overrides.occurredAt ?? CREATED,
    createdAt: overrides.createdAt ?? CREATED,
    readAt: overrides.readAt,
  };
}

async function cleanup(
  pool: Pool,
  input: { userIds: string[]; homeIds: string[] },
): Promise<void> {
  if (input.homeIds.length > 0) {
    await pool.query(
      'DELETE FROM notifications WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query(
      'DELETE FROM maintenance_audiences WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query(
      'DELETE FROM maintenance_entries WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query(
      'DELETE FROM memberships WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query('DELETE FROM homes WHERE id = ANY($1::uuid[])', [
      input.homeIds,
    ]);
  }
  if (input.userIds.length > 0) {
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
      input.userIds,
    ]);
  }
}

void describe('Notification eligible list and mark-one PostgreSQL', () => {
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
    'lists globally, pages around hidden rows, and marks only eligible unread rows',
    { skip: skipWithoutDatabase, timeout: 90_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const notifications = createNotificationRepository(database.pool);
      const maintenance = createMaintenanceRepository(database.pool);
      const alex = createUuidV7();
      const jamie = createUuidV7();
      const taylor = createUuidV7();
      const homeA = createUuidV7();
      const homeB = createUuidV7();
      const archived = createUuidV7();
      const alexA = createUuidV7();
      const alexAEnded = createUuidV7();
      const alexB = createUuidV7();
      const jamieA = createUuidV7();
      const taylorA = createUuidV7();
      const archivedMembership = createUuidV7();
      const privateA = createUuidV7();
      const privateB = createUuidV7();
      const household = createUuidV7();
      const missingPrivate = createUuidV7();
      const T = (ms: number) => new Date(Date.UTC(2026, 8, 13, 18, 0, 0, ms));
      try {
        await insertUser(database.pool, alex);
        await insertUser(database.pool, jamie);
        await insertUser(database.pool, taylor);
        await insertHome(database.pool, { id: homeA, name: 'Home A' });
        await insertHome(database.pool, { id: homeB, name: 'Home B' });
        await insertHome(database.pool, {
          id: archived,
          name: 'Archived',
          archived: true,
        });
        await insertMembership(database.pool, {
          id: alexAEnded,
          homeId: homeA,
          userId: alex,
          role: 'ROOMMATE',
          ended: true,
        });
        await insertMembership(database.pool, {
          id: alexA,
          homeId: homeA,
          userId: alex,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: alexB,
          homeId: homeB,
          userId: alex,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: jamieA,
          homeId: homeA,
          userId: jamie,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: taylorA,
          homeId: homeA,
          userId: taylor,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: archivedMembership,
          homeId: archived,
          userId: alex,
          role: 'ROOMMATE',
        });

        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await maintenance.insertEntryWithAudience(tx, {
            entry: {
              id: privateA,
              homeId: homeA,
              createdByMembershipId: alexA,
              visibility: 'PRIVATE',
              title: 'Private A leak title',
              details: 'PRIVATE_A_DETAILS',
              status: 'OPEN',
              resolvedByMembershipId: null,
              resolvedAt: null,
              createdAt: CREATED,
              updatedAt: CREATED,
            },
            audienceMembershipIds: [alexA],
          });
          await maintenance.insertEntryWithAudience(tx, {
            entry: {
              id: privateB,
              homeId: homeA,
              createdByMembershipId: jamieA,
              visibility: 'PRIVATE',
              title: 'Private B leak title',
              details: 'PRIVATE_B_DETAILS',
              status: 'OPEN',
              resolvedByMembershipId: null,
              resolvedAt: null,
              createdAt: CREATED,
              updatedAt: CREATED,
            },
            audienceMembershipIds: [jamieA],
          });
          await maintenance.insertEntryWithAudience(tx, {
            entry: {
              id: household,
              homeId: homeA,
              createdByMembershipId: taylorA,
              visibility: 'HOUSEHOLD',
              title: 'Household leak title',
              details: 'HOUSEHOLD_DETAILS',
              status: 'OPEN',
              resolvedByMembershipId: null,
              resolvedAt: null,
              createdAt: CREATED,
              updatedAt: CREATED,
            },
            audienceMembershipIds: [],
          });
        });

        const visibleA1 = row(homeA, alexA, {
          id: createUuidV7(),
          occurredAt: T(300),
          kind: 'ASSIGNED_TASK_COMPLETED',
        });
        const visibleB1 = row(homeB, alexB, {
          id: createUuidV7(),
          occurredAt: T(200),
          kind: 'CREATED_SUPPLY_OBTAINED',
        });
        const visibleA2 = row(homeA, alexA, {
          id: createUuidV7(),
          occurredAt: T(100),
          kind: 'MEMBERSHIP_ROLE_CHANGED',
        });
        const hiddenEnded = row(homeA, alexAEnded, {
          occurredAt: T(400),
          kind: 'ASSIGNED_TASK_COMPLETED',
        });
        const hiddenJamie = row(homeA, jamieA, {
          occurredAt: T(250),
          kind: 'ASSIGNED_TASK_COMPLETED',
        });
        const hiddenArchived = row(archived, archivedMembership, {
          occurredAt: T(350),
          kind: 'ASSIGNED_TASK_COMPLETED',
        });
        const hiddenPrivateB = row(homeA, alexA, {
          occurredAt: T(275),
          kind: 'PRIVATE_MAINTENANCE_CREATED',
          sourceEntityId: privateB,
        });
        const hiddenHouseholdKind = row(homeA, alexA, {
          occurredAt: T(225),
          kind: 'PRIVATE_MAINTENANCE_CREATED',
          sourceEntityId: household,
        });
        const hiddenMissing = row(homeA, alexA, {
          occurredAt: T(50),
          kind: 'PRIVATE_MAINTENANCE_CREATED',
          sourceEntityId: missingPrivate,
        });
        const visiblePrivateA = row(homeA, alexA, {
          occurredAt: T(150),
          kind: 'PRIVATE_MAINTENANCE_CREATED',
          sourceEntityId: privateA,
        });
        const jamiePrivateB = row(homeA, jamieA, {
          occurredAt: T(160),
          kind: 'PRIVATE_MAINTENANCE_CREATED',
          sourceEntityId: privateB,
        });
        const taylorPrivateA = row(homeA, taylorA, {
          occurredAt: T(140),
          kind: 'PRIVATE_MAINTENANCE_CREATED',
          sourceEntityId: privateA,
        });

        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await notifications.insertNotifications(tx, [
            visibleA1,
            visibleB1,
            visibleA2,
            hiddenEnded,
            hiddenJamie,
            hiddenArchived,
            hiddenPrivateB,
            hiddenHouseholdKind,
            hiddenMissing,
            visiblePrivateA,
            jamiePrivateB,
            taylorPrivateA,
          ]);
        });

        const alexPage = await notifications.listEligiblePageForUser({
          userId: alex,
          limit: 10,
        });
        assert.deepEqual(
          alexPage.items.map((item) => item.id),
          [visibleA1.id, visibleB1.id, visiblePrivateA.id, visibleA2.id],
        );
        assert.equal(alexPage.hasMore, false);
        assert.equal(
          alexPage.items.some((item) => item.id === hiddenEnded.id),
          false,
        );
        assert.equal(
          alexPage.items.some((item) => item.id === hiddenPrivateB.id),
          false,
        );
        assert.equal(
          alexPage.items.some((item) => item.id === hiddenHouseholdKind.id),
          false,
        );
        assert.equal(
          alexPage.items.some((item) => item.id === hiddenMissing.id),
          false,
        );
        assert.equal(
          alexPage.items.some((item) => item.id === jamiePrivateB.id),
          false,
        );

        const jamiePage = await notifications.listEligiblePageForUser({
          userId: jamie,
          limit: 10,
        });
        assert.deepEqual(
          jamiePage.items.map((item) => item.id),
          [hiddenJamie.id, jamiePrivateB.id],
        );
        assert.equal(
          jamiePage.items.some((item) => item.id === visiblePrivateA.id),
          false,
        );

        const taylorPage = await notifications.listEligiblePageForUser({
          userId: taylor,
          limit: 10,
        });
        assert.equal(
          taylorPage.items.some((item) => item.id === visiblePrivateA.id),
          false,
        );
        assert.equal(
          taylorPage.items.some((item) => item.id === jamiePrivateB.id),
          false,
        );
        assert.equal(
          taylorPage.items.some((item) => item.id === taylorPrivateA.id),
          false,
        );

        const first = await notifications.listEligiblePageForUser({
          userId: alex,
          limit: 2,
        });
        assert.deepEqual(
          first.items.map((item) => item.id),
          [visibleA1.id, visibleB1.id],
        );
        assert.equal(first.hasMore, true);
        assert.ok(first.nextCursor);
        const bound = bindNotificationListCursor(first.nextCursor, {
          userId: alex,
          queryFingerprint: NOTIFICATION_LIST_QUERY_FINGERPRINT,
        });
        assert.equal(bound.id, visibleB1.id);
        const second = await notifications.listEligiblePageForUser({
          userId: alex,
          limit: 2,
          cursor: first.nextCursor ?? undefined,
        });
        assert.deepEqual(
          second.items.map((item) => item.id),
          [visiblePrivateA.id, visibleA2.id],
        );
        assert.equal(second.hasMore, false);

        const controlIds = [
          visibleA1.id,
          visibleB1.id,
          visiblePrivateA.id,
          visibleA2.id,
        ];
        assert.deepEqual(
          alexPage.items.map((item) => item.id),
          controlIds,
        );

        const otherCursor = encodeNotificationListCursor({
          v: 1,
          occurredAt: visibleA1.occurredAt.toISOString(),
          id: visibleA1.id,
          userId: jamie,
          queryFingerprint: NOTIFICATION_LIST_QUERY_FINGERPRINT,
        });
        await assert.rejects(
          () =>
            notifications.listEligiblePageForUser({
              userId: alex,
              limit: 2,
              cursor: otherCursor,
            }),
          InvalidNotificationRequestError,
        );
        await assert.rejects(
          () =>
            notifications.listEligiblePageForUser({
              userId: alex,
              limit: 2,
              cursor: '%%%',
            }),
          InvalidNotificationRequestError,
        );

        const marked = await runInReadCommittedTransaction(
          database.pool,
          (tx) =>
            notifications.markEligibleRead(tx, {
              userId: alex,
              notificationId: visibleA1.id,
            }),
        );
        assert.equal(marked.outcome, 'marked');
        if (marked.outcome === 'marked') {
          assert.ok(marked.readAt instanceof Date);
        }
        const stored = await database.pool.query<{ read_at: Date }>(
          'SELECT read_at FROM notifications WHERE id = $1',
          [visibleA1.id],
        );
        assert.ok(stored.rows[0]?.read_at instanceof Date);
        if (marked.outcome === 'marked') {
          assert.equal(
            stored.rows[0]?.read_at.getTime(),
            marked.readAt.getTime(),
          );
        }
        const again = await runInReadCommittedTransaction(database.pool, (tx) =>
          notifications.markEligibleRead(tx, {
            userId: alex,
            notificationId: visibleA1.id,
          }),
        );
        assert.equal(again.outcome, 'already_read');
        if (again.outcome === 'already_read' && marked.outcome === 'marked') {
          assert.equal(again.readAt.getTime(), marked.readAt.getTime());
        }

        const otherMark = await runInReadCommittedTransaction(
          database.pool,
          (tx) =>
            notifications.markEligibleRead(tx, {
              userId: jamie,
              notificationId: visibleA1.id,
            }),
        );
        assert.equal(otherMark.outcome, 'not_found');
        const endedMark = await runInReadCommittedTransaction(
          database.pool,
          (tx) =>
            notifications.markEligibleRead(tx, {
              userId: alex,
              notificationId: hiddenEnded.id,
            }),
        );
        assert.equal(endedMark.outcome, 'not_found');
        const rejoinMark = await runInReadCommittedTransaction(
          database.pool,
          (tx) =>
            notifications.markEligibleRead(tx, {
              userId: alex,
              notificationId: hiddenEnded.id,
            }),
        );
        assert.equal(rejoinMark.outcome, 'not_found');
        const archivedMark = await runInReadCommittedTransaction(
          database.pool,
          (tx) =>
            notifications.markEligibleRead(tx, {
              userId: alex,
              notificationId: hiddenArchived.id,
            }),
        );
        assert.equal(archivedMark.outcome, 'not_found');
        const adminPrivate = await runInReadCommittedTransaction(
          database.pool,
          (tx) =>
            notifications.markEligibleRead(tx, {
              userId: taylor,
              notificationId: taylorPrivateA.id,
            }),
        );
        assert.equal(adminPrivate.outcome, 'not_found');
        const missingMark = await runInReadCommittedTransaction(
          database.pool,
          (tx) =>
            notifications.markEligibleRead(tx, {
              userId: alex,
              notificationId: hiddenMissing.id,
            }),
        );
        assert.equal(missingMark.outcome, 'not_found');

        const untouched = await database.pool.query<{
          id: string;
          read_at: Date | null;
        }>('SELECT id, read_at FROM notifications WHERE id = ANY($1::uuid[])', [
          [visibleB1.id, visibleA2.id, hiddenJamie.id],
        ]);
        assert.equal(
          untouched.rows.every((item) => item.read_at === null),
          true,
        );
      } finally {
        await cleanup(database.pool, {
          userIds: [alex, jamie, taylor],
          homeIds: [homeA, homeB, archived],
        });
        await database.close();
      }
    },
  );
});
