import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import type { AppConfig } from '../../platform/config/types.js';
import {
  ActivityPersistenceError,
  EmptyActivityRecipientSetError,
} from './errors.js';
import {
  createActivityRepository,
  INSERT_ACTIVITY_SQL,
  type NewActivity,
} from './repository.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const CREATED = new Date('2026-09-13T12:00:00.000Z');
const OCCURRED = new Date('2026-09-13T11:00:00.000Z');
const T1 = new Date('2026-09-13T12:10:00.000Z');
const T2 = new Date('2026-09-13T12:20:00.000Z');
const T3 = new Date('2026-09-13T12:30:00.000Z');
const T4 = new Date('2026-09-13T12:40:00.000Z');
const T5 = new Date('2026-09-13T12:50:00.000Z');
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';
const NOT_NULL_VIOLATION = '23502';

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

function sqlState(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
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

function activityInput(
  id: string,
  homeId: string,
  sourceOutboxEventId: string,
  overrides: Partial<NewActivity> = {},
): NewActivity {
  return {
    id,
    homeId,
    sourceOutboxEventId,
    sourceEntityType: overrides.sourceEntityType ?? 'MAINTENANCE',
    sourceEntityId: overrides.sourceEntityId ?? id,
    eventType: overrides.eventType ?? 'maintenance.created.v1',
    actorMembershipId:
      overrides.actorMembershipId === undefined
        ? null
        : overrides.actorMembershipId,
    occurredAt: overrides.occurredAt ?? OCCURRED,
    createdAt: overrides.createdAt ?? CREATED,
  };
}

function insertParams(
  activity: NewActivity,
  visibilityClass: string,
): unknown[] {
  return [
    activity.id,
    activity.homeId,
    activity.sourceOutboxEventId,
    activity.sourceEntityType,
    activity.sourceEntityId,
    activity.eventType,
    visibilityClass,
    activity.actorMembershipId,
    activity.occurredAt,
    activity.createdAt,
  ];
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

async function cleanup(
  pool: Pool,
  input: { userIds: string[]; homeIds: string[] },
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

void describe('Activity repository PostgreSQL', () => {
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
    'enforces Activity and ActivityRecipient schema constraints',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const users = [createUuidV7(), createUuidV7()] as const;
      const homeA = createUuidV7();
      const homeB = createUuidV7();
      const memberA = createUuidV7();
      const memberB = createUuidV7();
      const homeVisibleId = createUuidV7();
      const sourceAuthorizedId = createUuidV7();
      const client = await database.pool.connect();
      try {
        await insertUser(database.pool, users[0]);
        await insertUser(database.pool, users[1]);
        await insertHome(database.pool, { id: homeA, name: 'Home A' });
        await insertHome(database.pool, { id: homeB, name: 'Home B' });
        await insertMembership(database.pool, {
          id: memberA,
          homeId: homeA,
          userId: users[0],
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: memberB,
          homeId: homeB,
          userId: users[1],
          role: 'ADMIN',
        });

        await client.query('BEGIN');
        await client.query(
          INSERT_ACTIVITY_SQL,
          insertParams(
            activityInput(homeVisibleId, homeA, createUuidV7(), {
              actorMembershipId: memberA,
            }),
            'HOME_VISIBLE',
          ),
        );
        const storedHomeVisible = await client.query<{
          visibility_class: string;
        }>('SELECT visibility_class FROM activities WHERE id = $1', [
          homeVisibleId,
        ]);
        assert.equal(
          storedHomeVisible.rows[0]?.visibility_class,
          'HOME_VISIBLE',
        );
        const homeVisibleRecipients = await client.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM activity_recipients WHERE activity_id = $1',
          [homeVisibleId],
        );
        assert.equal(homeVisibleRecipients.rows[0]?.count, '0');

        await client.query(
          INSERT_ACTIVITY_SQL,
          insertParams(
            activityInput(sourceAuthorizedId, homeA, createUuidV7()),
            'SOURCE_AUTHORIZED',
          ),
        );
        await client.query(
          `INSERT INTO activity_recipients (
             home_id, activity_id, membership_id, created_at
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz)`,
          [homeA, sourceAuthorizedId, memberA, CREATED],
        );

        const duplicateOutbox = createUuidV7();
        const firstDuplicate = createUuidV7();
        await client.query(
          INSERT_ACTIVITY_SQL,
          insertParams(
            activityInput(firstDuplicate, homeA, duplicateOutbox),
            'HOME_VISIBLE',
          ),
        );
        await client.query('SAVEPOINT duplicate_outbox');
        try {
          await client.query(
            INSERT_ACTIVITY_SQL,
            insertParams(
              activityInput(createUuidV7(), homeA, duplicateOutbox),
              'HOME_VISIBLE',
            ),
          );
          assert.fail('expected duplicate source_outbox_event_id to fail');
        } catch (error) {
          assert.equal(sqlState(error), UNIQUE_VIOLATION);
          await client.query('ROLLBACK TO SAVEPOINT duplicate_outbox');
        }

        const otherActivity = createUuidV7();
        await client.query(
          INSERT_ACTIVITY_SQL,
          insertParams(
            activityInput(otherActivity, homeB, createUuidV7(), {
              actorMembershipId: memberB,
            }),
            'HOME_VISIBLE',
          ),
        );
        await client.query('SAVEPOINT recipient_cross_home_activity');
        try {
          await client.query(
            `INSERT INTO activity_recipients (
               home_id, activity_id, membership_id, created_at
             ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz)`,
            [homeA, otherActivity, memberA, CREATED],
          );
          assert.fail('expected cross-Home Activity recipient FK to fail');
        } catch (error) {
          assert.equal(sqlState(error), FOREIGN_KEY_VIOLATION);
          await client.query(
            'ROLLBACK TO SAVEPOINT recipient_cross_home_activity',
          );
        }

        await client.query('SAVEPOINT recipient_cross_home_membership');
        try {
          await client.query(
            `INSERT INTO activity_recipients (
               home_id, activity_id, membership_id, created_at
             ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz)`,
            [homeA, sourceAuthorizedId, memberB, CREATED],
          );
          assert.fail('expected cross-Home Membership recipient FK to fail');
        } catch (error) {
          assert.equal(sqlState(error), FOREIGN_KEY_VIOLATION);
          await client.query(
            'ROLLBACK TO SAVEPOINT recipient_cross_home_membership',
          );
        }

        await client.query('SAVEPOINT actor_cross_home');
        try {
          await client.query(
            INSERT_ACTIVITY_SQL,
            insertParams(
              activityInput(createUuidV7(), homeA, createUuidV7(), {
                actorMembershipId: memberB,
              }),
              'HOME_VISIBLE',
            ),
          );
          assert.fail('expected cross-Home actor Membership FK to fail');
        } catch (error) {
          assert.equal(sqlState(error), FOREIGN_KEY_VIOLATION);
          await client.query('ROLLBACK TO SAVEPOINT actor_cross_home');
        }

        await client.query('SAVEPOINT invalid_visibility');
        try {
          await client.query(
            INSERT_ACTIVITY_SQL,
            insertParams(
              activityInput(createUuidV7(), homeA, createUuidV7()),
              'PRIVATE',
            ),
          );
          assert.fail('expected invalid visibility to fail');
        } catch (error) {
          assert.equal(sqlState(error), CHECK_VIOLATION);
          await client.query('ROLLBACK TO SAVEPOINT invalid_visibility');
        }

        await client.query('SAVEPOINT invalid_source_type');
        try {
          await client.query(
            INSERT_ACTIVITY_SQL,
            insertParams(
              activityInput(createUuidV7(), homeA, createUuidV7(), {
                sourceEntityType: 'INVITATION' as never,
              }),
              'HOME_VISIBLE',
            ),
          );
          assert.fail('expected invalid source type to fail');
        } catch (error) {
          assert.equal(sqlState(error), CHECK_VIOLATION);
          await client.query('ROLLBACK TO SAVEPOINT invalid_source_type');
        }

        await client.query('SAVEPOINT empty_event_type');
        try {
          await client.query(
            INSERT_ACTIVITY_SQL,
            insertParams(
              activityInput(createUuidV7(), homeA, createUuidV7(), {
                eventType: '',
              }),
              'HOME_VISIBLE',
            ),
          );
          assert.fail('expected empty eventType to fail');
        } catch (error) {
          assert.equal(sqlState(error), CHECK_VIOLATION);
          await client.query('ROLLBACK TO SAVEPOINT empty_event_type');
        }

        await client.query('SAVEPOINT null_occurred_at');
        try {
          await client.query(
            `INSERT INTO activities (
               id, home_id, source_outbox_event_id, source_entity_type,
               source_entity_id, event_type, visibility_class,
               actor_membership_id, occurred_at, created_at
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, 'TASK', $1::uuid,
               'task.created.v1', 'HOME_VISIBLE', NULL, NULL, $4::timestamptz
             )`,
            [createUuidV7(), homeA, createUuidV7(), CREATED],
          );
          assert.fail('expected null occurred_at to fail');
        } catch (error) {
          assert.equal(sqlState(error), NOT_NULL_VIOLATION);
          await client.query('ROLLBACK TO SAVEPOINT null_occurred_at');
        }

        await client.query('SAVEPOINT null_created_at');
        try {
          await client.query(
            `INSERT INTO activities (
               id, home_id, source_outbox_event_id, source_entity_type,
               source_entity_id, event_type, visibility_class,
               actor_membership_id, occurred_at, created_at
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, 'TASK', $1::uuid,
               'task.created.v1', 'HOME_VISIBLE', NULL, $4::timestamptz, NULL
             )`,
            [createUuidV7(), homeA, createUuidV7(), OCCURRED],
          );
          assert.fail('expected null created_at to fail');
        } catch (error) {
          assert.equal(sqlState(error), NOT_NULL_VIOLATION);
          await client.query('ROLLBACK TO SAVEPOINT null_created_at');
        }
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
        await cleanup(database.pool, {
          userIds: [...users],
          homeIds: [homeA, homeB],
        });
        await database.close();
      }
    },
  );

  void it(
    'inserts HOME_VISIBLE and SOURCE_AUTHORIZED atomically with recipient rules',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const repository = createActivityRepository(database.pool);
      const users = [createUuidV7(), createUuidV7()] as const;
      const homeA = createUuidV7();
      const homeB = createUuidV7();
      const alex = createUuidV7();
      const jamie = createUuidV7();
      const other = createUuidV7();
      const homeVisibleId = createUuidV7();
      const sourceAuthorizedId = createUuidV7();
      const dedupId = createUuidV7();
      const emptyId = createUuidV7();
      const rollbackId = createUuidV7();
      try {
        await insertUser(database.pool, users[0]);
        await insertUser(database.pool, users[1]);
        await insertHome(database.pool, { id: homeA, name: 'Insert home' });
        await insertHome(database.pool, { id: homeB, name: 'Other home' });
        await insertMembership(database.pool, {
          id: alex,
          homeId: homeA,
          userId: users[0],
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: jamie,
          homeId: homeA,
          userId: users[1],
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: other,
          homeId: homeB,
          userId: users[1],
          role: 'ADMIN',
        });

        const homeVisible = await runInReadCommittedTransaction(
          database.pool,
          async (tx) =>
            repository.insertHomeVisibleActivity(
              tx,
              activityInput(homeVisibleId, homeA, createUuidV7(), {
                actorMembershipId: alex,
              }),
            ),
        );
        assert.equal(homeVisible.outcome, 'inserted');
        if (homeVisible.outcome === 'inserted') {
          assert.equal(homeVisible.activity.visibilityClass, 'HOME_VISIBLE');
          assert.equal(homeVisible.activity.actorMembershipId, alex);
          assert.notEqual(
            homeVisible.activity.createdAt.toISOString(),
            homeVisible.activity.occurredAt.toISOString(),
          );
        }
        assert.deepEqual(await recipientIds(database.pool, homeVisibleId), []);

        const sourceAuthorized = await runInReadCommittedTransaction(
          database.pool,
          async (tx) =>
            repository.insertSourceAuthorizedActivity(
              tx,
              activityInput(sourceAuthorizedId, homeA, createUuidV7()),
              [jamie, alex],
            ),
        );
        assert.equal(sourceAuthorized.outcome, 'inserted');
        if (sourceAuthorized.outcome === 'inserted') {
          assert.equal(
            sourceAuthorized.activity.visibilityClass,
            'SOURCE_AUTHORIZED',
          );
        }
        assert.deepEqual(
          await recipientIds(database.pool, sourceAuthorizedId),
          [alex < jamie ? alex : jamie, alex < jamie ? jamie : alex],
        );

        await runInReadCommittedTransaction(database.pool, async (tx) => {
          const result = await repository.insertSourceAuthorizedActivity(
            tx,
            activityInput(dedupId, homeA, createUuidV7()),
            [jamie, alex, jamie, alex],
          );
          assert.equal(result.outcome, 'inserted');
        });
        assert.deepEqual(await recipientIds(database.pool, dedupId), [
          alex < jamie ? alex : jamie,
          alex < jamie ? jamie : alex,
        ]);

        await assert.rejects(
          () =>
            runInReadCommittedTransaction(database.pool, async (tx) =>
              repository.insertSourceAuthorizedActivity(
                tx,
                activityInput(emptyId, homeA, createUuidV7()),
                [],
              ),
            ),
          EmptyActivityRecipientSetError,
        );
        const emptyCount = await database.pool.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM activities WHERE id = $1',
          [emptyId],
        );
        assert.equal(emptyCount.rows[0]?.count, '0');

        await assert.rejects(
          () =>
            runInReadCommittedTransaction(database.pool, async (tx) =>
              repository.insertSourceAuthorizedActivity(
                tx,
                activityInput(rollbackId, homeA, createUuidV7()),
                [alex, other],
              ),
            ),
          ActivityPersistenceError,
        );
        const rolledBack = await database.pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM activities WHERE id = $1`,
          [rollbackId],
        );
        assert.equal(rolledBack.rows[0]?.count, '0');
        const rolledBackRecipients = await database.pool.query<{
          count: string;
        }>(
          `SELECT COUNT(*)::text AS count FROM activity_recipients WHERE activity_id = $1`,
          [rollbackId],
        );
        assert.equal(rolledBackRecipients.rows[0]?.count, '0');
      } finally {
        await cleanup(database.pool, {
          userIds: [...users],
          homeIds: [homeA, homeB],
        });
        await database.close();
      }
    },
  );

  void it(
    'proves the Alex/Jamie/Taylor/FormerAlex/Morgan visibility sentinel',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const repository = createActivityRepository(database.pool);
      const users = [
        createUuidV7(),
        createUuidV7(),
        createUuidV7(),
        createUuidV7(),
      ] as const;
      const homeA = createUuidV7();
      const homeB = createUuidV7();
      const alex = createUuidV7();
      const jamie = createUuidV7();
      const taylor = createUuidV7();
      const formerAlex = createUuidV7();
      const morgan = createUuidV7();
      const H = createUuidV7();
      const A = createUuidV7();
      const J = createUuidV7();
      const AJ = createUuidV7();
      const OLD = createUuidV7();
      try {
        await insertUser(database.pool, users[0]);
        await insertUser(database.pool, users[1]);
        await insertUser(database.pool, users[2]);
        await insertUser(database.pool, users[3]);
        await insertHome(database.pool, { id: homeA, name: 'Home A' });
        await insertHome(database.pool, { id: homeB, name: 'Home B' });
        await insertMembership(database.pool, {
          id: formerAlex,
          homeId: homeA,
          userId: users[0],
          role: 'ROOMMATE',
          ended: true,
        });
        await insertMembership(database.pool, {
          id: alex,
          homeId: homeA,
          userId: users[0],
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: jamie,
          homeId: homeA,
          userId: users[1],
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: taylor,
          homeId: homeA,
          userId: users[2],
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: morgan,
          homeId: homeB,
          userId: users[3],
          role: 'ROOMMATE',
        });

        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await repository.insertHomeVisibleActivity(
            tx,
            activityInput(H, homeA, createUuidV7(), {
              actorMembershipId: taylor,
              occurredAt: T5,
            }),
          );
          await repository.insertSourceAuthorizedActivity(
            tx,
            activityInput(A, homeA, createUuidV7(), { occurredAt: T4 }),
            [alex],
          );
          await repository.insertSourceAuthorizedActivity(
            tx,
            activityInput(J, homeA, createUuidV7(), { occurredAt: T3 }),
            [jamie],
          );
          await repository.insertSourceAuthorizedActivity(
            tx,
            activityInput(AJ, homeA, createUuidV7(), { occurredAt: T2 }),
            [alex, jamie],
          );
          await repository.insertSourceAuthorizedActivity(
            tx,
            activityInput(OLD, homeA, createUuidV7(), { occurredAt: T1 }),
            [formerAlex],
          );
        });

        const ids = async (actor: string) =>
          (await repository.listVisibleByHome(homeA, actor))?.map(
            (item) => item.id,
          );

        assert.deepEqual(await ids(alex), [H, A, AJ]);
        assert.deepEqual(await ids(jamie), [H, J, AJ]);
        assert.deepEqual(await ids(taylor), [H]);
        assert.equal(
          await repository.listVisibleByHome(homeA, formerAlex),
          null,
        );
        assert.equal(await repository.listVisibleByHome(homeA, morgan), null);
        assert.deepEqual(await ids(taylor), [H]);

        assert.equal(
          (await repository.findVisibleByHomeAndId(homeA, A, alex))?.id,
          A,
        );
        assert.equal(
          await repository.findVisibleByHomeAndId(homeA, J, alex),
          null,
        );
        assert.equal(
          await repository.findVisibleByHomeAndId(homeA, OLD, alex),
          null,
        );
        assert.equal(
          await repository.findVisibleByHomeAndId(homeA, A, taylor),
          null,
        );
        assert.equal(
          (await repository.findVisibleByHomeAndId(homeA, H, taylor))?.id,
          H,
        );
        assert.equal(
          await repository.findVisibleByHomeAndId(homeA, H, formerAlex),
          null,
        );
        assert.equal(
          await repository.findVisibleByHomeAndId(homeA, H, morgan),
          null,
        );
      } finally {
        await cleanup(database.pool, {
          userIds: [...users],
          homeIds: [homeA, homeB],
        });
        await database.close();
      }
    },
  );

  void it(
    'keeps rejoin and archived-home visibility on exact Membership tenure',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const repository = createActivityRepository(database.pool);
      const userId = createUuidV7();
      const homeId = createUuidV7();
      const archivedHome = createUuidV7();
      const membershipA = createUuidV7();
      const membershipB = createUuidV7();
      const archivedMembership = createUuidV7();
      const oldActivity = createUuidV7();
      const newActivity = createUuidV7();
      const archivedActivity = createUuidV7();
      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, { id: homeId, name: 'Tenure home' });
        await insertHome(database.pool, {
          id: archivedHome,
          name: 'Archived',
          archived: true,
        });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId,
          role: 'ROOMMATE',
          ended: true,
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId,
          userId,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: archivedMembership,
          homeId: archivedHome,
          userId,
          role: 'ADMIN',
        });

        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await repository.insertSourceAuthorizedActivity(
            tx,
            activityInput(oldActivity, homeId, createUuidV7(), {
              occurredAt: T1,
            }),
            [membershipA],
          );
          await repository.insertHomeVisibleActivity(
            tx,
            activityInput(archivedActivity, archivedHome, createUuidV7(), {
              actorMembershipId: archivedMembership,
            }),
          );
        });

        assert.equal(
          await repository.listVisibleByHome(homeId, membershipA),
          null,
        );
        assert.deepEqual(
          await repository.listVisibleByHome(homeId, membershipB),
          [],
        );
        assert.equal(
          await repository.findVisibleByHomeAndId(
            homeId,
            oldActivity,
            membershipB,
          ),
          null,
        );

        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await repository.insertSourceAuthorizedActivity(
            tx,
            activityInput(newActivity, homeId, createUuidV7(), {
              occurredAt: T2,
            }),
            [membershipB],
          );
        });
        assert.deepEqual(
          (await repository.listVisibleByHome(homeId, membershipB))?.map(
            (item) => item.id,
          ),
          [newActivity],
        );
        assert.equal(
          await repository.findVisibleByHomeAndId(
            homeId,
            oldActivity,
            membershipB,
          ),
          null,
        );

        assert.equal(
          await repository.listVisibleByHome(archivedHome, archivedMembership),
          null,
        );
        assert.equal(
          await repository.findVisibleByHomeAndId(
            archivedHome,
            archivedActivity,
            archivedMembership,
          ),
          null,
        );
      } finally {
        await cleanup(database.pool, {
          userIds: [userId],
          homeIds: [homeId, archivedHome],
        });
        await database.close();
      }
    },
  );

  void it(
    'returns a typed duplicate only for the sourceOutboxEvent unique constraint',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const repository = createActivityRepository(database.pool);
      const userId = createUuidV7();
      const homeId = createUuidV7();
      const actor = createUuidV7();
      const firstId = createUuidV7();
      const secondId = createUuidV7();
      const sourceOutboxEventId = createUuidV7();
      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, { id: homeId, name: 'Idempotency' });
        await insertMembership(database.pool, {
          id: actor,
          homeId,
          userId,
          role: 'ADMIN',
        });

        const first = await runInReadCommittedTransaction(
          database.pool,
          async (tx) =>
            repository.insertHomeVisibleActivity(
              tx,
              activityInput(firstId, homeId, sourceOutboxEventId, {
                actorMembershipId: actor,
              }),
            ),
        );
        assert.equal(first.outcome, 'inserted');

        const second = await runInReadCommittedTransaction(
          database.pool,
          async (tx) =>
            repository.insertSourceAuthorizedActivity(
              tx,
              activityInput(secondId, homeId, sourceOutboxEventId),
              [actor],
            ),
        );
        assert.deepEqual(second, {
          outcome: 'duplicate_source_outbox_event',
          sourceOutboxEventId,
        });

        const stored =
          await repository.findBySourceOutboxEventId(sourceOutboxEventId);
        assert.equal(stored?.id, firstId);
        assert.equal(stored?.visibilityClass, 'HOME_VISIBLE');
        const count = await database.pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM activities
           WHERE source_outbox_event_id = $1`,
          [sourceOutboxEventId],
        );
        assert.equal(count.rows[0]?.count, '1');
        assert.deepEqual(await recipientIds(database.pool, firstId), []);
        assert.deepEqual(await recipientIds(database.pool, secondId), []);
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
