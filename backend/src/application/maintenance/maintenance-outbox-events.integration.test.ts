import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import {
  MAINTENANCE_CREATED_V1,
  MAINTENANCE_RESOLVED_V1,
} from '../../domains/maintenance/events.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import type { AppConfig } from '../../platform/config/types.js';
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { createCreateMaintenanceEntryFromPool } from './create-maintenance-entry.js';
import { createResolveMaintenanceEntryFromPool } from './resolve-maintenance-entry.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const TITLE_SENTINEL = 'SENTINEL_MAINT_TITLE_LEAK_M63';
const DETAILS_SENTINEL = 'SENTINEL_MAINT_DETAILS_LEAK_M63';

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
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO memberships (id, home_id, user_id, role, ended_at, ended_by_membership_id)
     VALUES ($1, $2, $3, $4, NULL, NULL)`,
    [input.id, input.homeId, input.userId, input.role],
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

type OutboxRow = {
  event_id: string;
  event_type: string;
  occurred_at: Date;
  home_id: string | null;
  payload: unknown;
};

async function maintenanceEvents(
  pool: Pool,
  homeId: string,
): Promise<readonly OutboxRow[]> {
  const result = await pool.query<OutboxRow>(
    `SELECT event_id, event_type, occurred_at, home_id, payload
     FROM outbox_events
     WHERE home_id = $1
       AND event_type LIKE 'maintenance%'
     ORDER BY created_at ASC, event_id ASC`,
    [homeId],
  );
  return result.rows;
}

function payloadJson(payload: unknown): string {
  return JSON.stringify(payload);
}

void describe('Maintenance outbox event production PostgreSQL', () => {
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
    'writes exactly one created event for HOUSEHOLD and PRIVATE success',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const create = createCreateMaintenanceEntryFromPool(database.pool);
      const userA = randomUUID();
      const userB = randomUUID();
      const homeId = createUuidV7();
      const actorId = createUuidV7();
      const recipientId = createUuidV7();

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeId, name: 'Events home' });
        await insertMembership(database.pool, {
          id: actorId,
          homeId,
          userId: userA,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: recipientId,
          homeId,
          userId: userB,
          role: 'ROOMMATE',
        });
        const roommate = actor({
          userId: userA,
          membershipId: actorId,
          homeId,
          role: 'ROOMMATE',
        });

        const household = await create({
          actor: roommate,
          homeId,
          visibility: 'HOUSEHOLD',
          title: TITLE_SENTINEL,
          details: DETAILS_SENTINEL,
        });
        const householdEvents = await maintenanceEvents(database.pool, homeId);
        assert.equal(householdEvents.length, 1);
        assert.equal(householdEvents[0]?.event_type, MAINTENANCE_CREATED_V1);
        assert.equal(householdEvents[0]?.home_id, homeId);
        assert.equal(
          householdEvents[0]?.occurred_at.getTime(),
          household.createdAt.getTime(),
        );
        assert.deepEqual(householdEvents[0]?.payload, {
          maintenanceEntryId: household.id,
        });
        assert.deepEqual(Object.keys(householdEvents[0]?.payload ?? {}), [
          'maintenanceEntryId',
        ]);
        const householdJson = payloadJson(householdEvents[0]?.payload);
        assert.equal(householdJson.includes(TITLE_SENTINEL), false);
        assert.equal(householdJson.includes(DETAILS_SENTINEL), false);
        assert.equal(householdJson.includes(actorId), false);
        assert.equal(householdJson.includes(userA), false);

        const privateEntry = await create({
          actor: roommate,
          homeId,
          visibility: 'PRIVATE',
          title: TITLE_SENTINEL,
          details: DETAILS_SENTINEL,
          audienceMembershipIds: [recipientId],
        });
        const afterPrivate = await maintenanceEvents(database.pool, homeId);
        assert.equal(afterPrivate.length, 2);
        const privateEvent = afterPrivate[1];
        assert.equal(privateEvent?.event_type, MAINTENANCE_CREATED_V1);
        assert.deepEqual(privateEvent?.payload, {
          maintenanceEntryId: privateEntry.id,
        });
        const privateJson = payloadJson(privateEvent?.payload);
        assert.equal(privateJson.includes(TITLE_SENTINEL), false);
        assert.equal(privateJson.includes(DETAILS_SENTINEL), false);
        assert.equal(privateJson.includes(recipientId), false);
        assert.equal(privateJson.includes('PRIVATE'), false);
        assert.equal(privateJson.includes('audience'), false);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userA, userB],
        });
        await database.close();
      }
    },
  );

  void it(
    'writes no event when create fails and one resolve event on success only',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const create = createCreateMaintenanceEntryFromPool(database.pool);
      const resolve = createResolveMaintenanceEntryFromPool(database.pool);
      const userA = randomUUID();
      const homeId = createUuidV7();
      const actorId = createUuidV7();
      const missing = createUuidV7();

      try {
        await insertUser(database.pool, userA);
        await insertHome(database.pool, { id: homeId, name: 'Fail events' });
        await insertMembership(database.pool, {
          id: actorId,
          homeId,
          userId: userA,
          role: 'ROOMMATE',
        });
        const roommate = actor({
          userId: userA,
          membershipId: actorId,
          homeId,
          role: 'ROOMMATE',
        });

        await assert.rejects(
          () =>
            create({
              actor: roommate,
              homeId,
              visibility: 'PRIVATE',
              title: TITLE_SENTINEL,
              audienceMembershipIds: [missing],
            }),
          ConcealedNotFoundError,
        );
        assert.equal(
          (await maintenanceEvents(database.pool, homeId)).length,
          0,
        );

        const created = await create({
          actor: roommate,
          homeId,
          visibility: 'HOUSEHOLD',
          title: TITLE_SENTINEL,
        });
        const resolved = await resolve({
          actor: roommate,
          homeId,
          maintenanceEntryId: created.id,
        });
        const events = await maintenanceEvents(database.pool, homeId);
        assert.equal(events.length, 2);
        assert.equal(events[0]?.event_type, MAINTENANCE_CREATED_V1);
        assert.equal(events[1]?.event_type, MAINTENANCE_RESOLVED_V1);
        assert.equal(
          events[1]?.occurred_at.getTime(),
          resolved.resolvedAt?.getTime(),
        );
        assert.deepEqual(events[1]?.payload, {
          maintenanceEntryId: created.id,
        });
        assert.equal(
          payloadJson(events[1]?.payload).includes(TITLE_SENTINEL),
          false,
        );

        await assert.rejects(() =>
          resolve({
            actor: roommate,
            homeId,
            maintenanceEntryId: created.id,
          }),
        );
        assert.equal(
          (await maintenanceEvents(database.pool, homeId)).length,
          2,
        );
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userA],
        });
        await database.close();
      }
    },
  );
});
