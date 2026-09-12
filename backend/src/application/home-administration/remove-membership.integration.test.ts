import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { lockHomeStructure } from '../../domains/homes/lock-home-structure.js';
import { LastAdminRequiredError } from '../../domains/memberships/errors.js';
import { createMembershipEndingWriter } from '../../domains/memberships/update-active-membership-ended-at.js';
import { createMembershipRoleWriter } from '../../domains/memberships/update-active-membership-role.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  ForbiddenError,
} from '../../platform/authz/errors.js';
import type { AppConfig } from '../../platform/config/types.js';
import { createOutboxWriter } from '../../platform/events/outbox-writer.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import { createChangeMembershipRole } from './change-membership-role.js';
import { createEndMembershipWithinHomeStructure } from './end-membership-within-home-structure.js';
import { createRemoveMembership } from './remove-membership.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const TASK_MARKER_AT = new Date('2026-01-01T00:00:00.000Z');

function nextEventId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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

function dedicatedTestDatabaseUrl(): string {
  return resolveSafeDedicatedTestDatabaseUrl();
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
    `INSERT INTO homes (id, name, timezone, updated_at)
     VALUES ($1, $2, 'UTC', NOW())`,
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
  input: { homeIds: string[]; userIds: string[] },
): Promise<void> {
  await pool.query(
    'DELETE FROM outbox_events WHERE home_id = ANY($1::uuid[])',
    [input.homeIds],
  );
  await pool.query('DELETE FROM memberships WHERE home_id = ANY($1::uuid[])', [
    input.homeIds,
  ]);
  await pool.query('DELETE FROM homes WHERE id = ANY($1::uuid[])', [
    input.homeIds,
  ]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
    input.userIds,
  ]);
}

function createCommand(
  pool: Pool,
  overrides: Partial<Parameters<typeof createRemoveMembership>[0]> = {},
) {
  return createRemoveMembership({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeStructure,
    clock: { now: () => new Date('2026-03-15T12:34:56.789Z') },
    endMembership: createEndMembershipWithinHomeStructure({
      taskCleanup: {
        handleMembershipEnded() {
          return Promise.resolve();
        },
      },
      supplyCleanup: {
        handleMembershipEnded() {
          return Promise.resolve();
        },
      },
      membershipEnding: createMembershipEndingWriter(),
      outbox: createOutboxWriter(),
      ids: { next: nextEventId },
    }),
    ...overrides,
  });
}

function createRoleChange(pool: Pool) {
  return createChangeMembershipRole({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeStructure,
    outbox: createOutboxWriter(),
    clock: { now: () => new Date('2026-03-15T12:34:56.789Z') },
    ids: { next: nextEventId },
    roleWriter: createMembershipRoleWriter(),
  });
}

async function membershipRows(
  pool: Pool,
  homeId: string,
): Promise<readonly { id: string; role: string; ended_at: Date | null }[]> {
  const result = await pool.query<{
    id: string;
    role: string;
    ended_at: Date | null;
  }>(
    `SELECT id, role, ended_at
     FROM memberships
     WHERE home_id = $1
     ORDER BY id`,
    [homeId],
  );
  return result.rows;
}

async function endedEvents(
  pool: Pool,
  homeId: string,
): Promise<readonly { membershipId: string; cause: string }[]> {
  const result = await pool.query<{
    payload: { membershipId: string; cause: string };
  }>(
    `SELECT payload
     FROM outbox_events
     WHERE home_id = $1 AND event_type = 'membership.ended.v1'`,
    [homeId],
  );
  return result.rows.map((row) => row.payload);
}

async function archivedAt(pool: Pool, homeId: string): Promise<Date | null> {
  const result = await pool.query<{ archived_at: Date | null }>(
    'SELECT archived_at FROM homes WHERE id = $1',
    [homeId],
  );
  return result.rows[0]?.archived_at ?? null;
}

void describe('removeMembership PostgreSQL', () => {
  void it(
    'uses only a dedicated safe TEST_DATABASE_URL',
    { skip: skipWithoutDatabase },
    () => {
      const url = dedicatedTestDatabaseUrl();
      const parsed = parseDatabaseUrl(url);
      assert.notEqual(parsed.database.toLowerCase(), 'roomies');
      assert.match(parsed.database, /(?:^|_)(?:test|ci)$/i);
    },
  );

  void it(
    'ends the Roommate tenure, leaves the Admin untouched, and writes one ADMIN_REMOVAL event',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const membershipB = randomUUID();

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, {
          id: homeId,
          name: 'Remove Roommate',
        });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId,
          userId: userB,
          role: 'ROOMMATE',
        });

        const remove = createCommand(database.pool);
        await remove({
          actor: actor({
            userId: userA,
            membershipId: membershipA,
            homeId,
            role: 'ADMIN',
          }),
          homeId,
          membershipId: membershipB,
        });

        const rows = await membershipRows(database.pool, homeId);
        const admin = rows.find((row) => row.id === membershipA);
        const roommate = rows.find((row) => row.id === membershipB);
        assert.equal(admin?.role, 'ADMIN');
        assert.equal(admin?.ended_at, null);
        assert.equal(roommate?.role, 'ROOMMATE');
        assert.ok(roommate?.ended_at instanceof Date);
        assert.equal(await archivedAt(database.pool, homeId), null);
        assert.deepEqual(await endedEvents(database.pool, homeId), [
          { membershipId: membershipB, cause: 'ADMIN_REMOVAL' },
        ]);
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
    'allows an Admin to remove a peer Admin while remaining Admin',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const membershipB = randomUUID();

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeId, name: 'Remove Admin' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId,
          userId: userB,
          role: 'ADMIN',
        });

        const remove = createCommand(database.pool);
        await remove({
          actor: actor({
            userId: userA,
            membershipId: membershipA,
            homeId,
            role: 'ADMIN',
          }),
          homeId,
          membershipId: membershipB,
        });

        const rows = await membershipRows(database.pool, homeId);
        assert.equal(
          rows.find((row) => row.id === membershipA)?.ended_at,
          null,
        );
        assert.equal(rows.find((row) => row.id === membershipA)?.role, 'ADMIN');
        assert.ok(
          rows.find((row) => row.id === membershipB)?.ended_at instanceof Date,
        );
        assert.equal(rows.find((row) => row.id === membershipB)?.role, 'ADMIN');
        assert.deepEqual(await endedEvents(database.pool, homeId), [
          { membershipId: membershipB, cause: 'ADMIN_REMOVAL' },
        ]);
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
    'forbids self-remove without ending or LAST_ROOMMATE_REQUIRES_ARCHIVE',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const membershipB = randomUUID();
      const endingCalls: unknown[] = [];

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeId, name: 'Self Remove' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId,
          userId: userB,
          role: 'ROOMMATE',
        });

        const remove = createCommand(database.pool, {
          endMembership() {
            endingCalls.push('called');
            return Promise.reject(new Error('ending seam must not run'));
          },
        });

        await assert.rejects(
          () =>
            remove({
              actor: actor({
                userId: userA,
                membershipId: membershipA,
                homeId,
                role: 'ADMIN',
              }),
              homeId,
              membershipId: membershipA,
            }),
          ForbiddenError,
        );

        const rows = await membershipRows(database.pool, homeId);
        assert.equal(
          rows.every((row) => row.ended_at === null),
          true,
        );
        assert.deepEqual(await endedEvents(database.pool, homeId), []);
        assert.deepEqual(endingCalls, []);
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
    'forbids a Roommate remove without invoking the ending seam',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const membershipB = randomUUID();
      const missing = randomUUID();
      const endingCalls: unknown[] = [];

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeId, name: 'Roommate Deny' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId,
          userId: userB,
          role: 'ROOMMATE',
        });

        const remove = createCommand(database.pool, {
          endMembership() {
            endingCalls.push('called');
            return Promise.reject(new Error('ending seam must not run'));
          },
        });

        await assert.rejects(
          () =>
            remove({
              actor: actor({
                userId: userB,
                membershipId: membershipB,
                homeId,
                role: 'ROOMMATE',
              }),
              homeId,
              membershipId: membershipA,
            }),
          ForbiddenError,
        );
        await assert.rejects(
          () =>
            remove({
              actor: actor({
                userId: userB,
                membershipId: membershipB,
                homeId,
                role: 'ROOMMATE',
              }),
              homeId,
              membershipId: missing,
            }),
          ForbiddenError,
        );

        const rows = await membershipRows(database.pool, homeId);
        assert.equal(
          rows.every((row) => row.ended_at === null),
          true,
        );
        assert.deepEqual(await endedEvents(database.pool, homeId), []);
        assert.deepEqual(endingCalls, []);
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
    'conceals missing, ended, cross-Home, and OLD tenure targets',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const userC = randomUUID();
      const homeX = randomUUID();
      const homeY = randomUUID();
      const membershipA = randomUUID();
      const membershipOld = randomUUID();
      const membershipNew = randomUUID();
      const membershipY = randomUUID();
      const endedInX = randomUUID();
      const missing = randomUUID();

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertUser(database.pool, userC);
        await insertHome(database.pool, { id: homeX, name: 'Home X' });
        await insertHome(database.pool, { id: homeY, name: 'Home Y' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId: homeX,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: endedInX,
          homeId: homeX,
          userId: userC,
          role: 'ROOMMATE',
          ended: true,
        });
        await insertMembership(database.pool, {
          id: membershipOld,
          homeId: homeX,
          userId: userB,
          role: 'ROOMMATE',
          ended: true,
        });
        await insertMembership(database.pool, {
          id: membershipNew,
          homeId: homeX,
          userId: userB,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: membershipY,
          homeId: homeY,
          userId: userC,
          role: 'ADMIN',
        });

        const remove = createCommand(database.pool);
        const adminActor = actor({
          userId: userA,
          membershipId: membershipA,
          homeId: homeX,
          role: 'ADMIN',
        });

        await assert.rejects(
          () =>
            remove({
              actor: adminActor,
              homeId: homeX,
              membershipId: missing,
            }),
          ConcealedNotFoundError,
        );
        await assert.rejects(
          () =>
            remove({
              actor: adminActor,
              homeId: homeX,
              membershipId: endedInX,
            }),
          ConcealedNotFoundError,
        );
        await assert.rejects(
          () =>
            remove({
              actor: adminActor,
              homeId: homeX,
              membershipId: membershipY,
            }),
          ConcealedNotFoundError,
        );
        await assert.rejects(
          () =>
            remove({
              actor: adminActor,
              homeId: homeX,
              membershipId: membershipOld,
            }),
          ConcealedNotFoundError,
        );

        const newTenure = await database.pool.query<{
          ended_at: Date | null;
        }>('SELECT ended_at FROM memberships WHERE id = $1', [membershipNew]);
        assert.equal(newTenure.rows[0]?.ended_at, null);
        const otherHome = await database.pool.query<{
          ended_at: Date | null;
        }>('SELECT ended_at FROM memberships WHERE id = $1', [membershipY]);
        assert.equal(otherHome.rows[0]?.ended_at, null);
        assert.deepEqual(await endedEvents(database.pool, homeX), []);
        assert.deepEqual(await endedEvents(database.pool, homeY), []);

        await remove({
          actor: adminActor,
          homeId: homeX,
          membershipId: membershipNew,
        });
        const endedNew = await database.pool.query<{
          ended_at: Date | null;
        }>('SELECT ended_at FROM memberships WHERE id = $1', [membershipNew]);
        assert.ok(endedNew.rows[0]?.ended_at instanceof Date);
        assert.deepEqual(await endedEvents(database.pool, homeX), [
          { membershipId: membershipNew, cause: 'ADMIN_REMOVAL' },
        ]);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeX, homeY],
          userIds: [userA, userB, userC],
        });
        await database.close();
      }
    },
  );

  void it(
    'authorizes from the locked role after a prior demotion, not the stale request role',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const userC = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const membershipB = randomUUID();
      const membershipC = randomUUID();

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertUser(database.pool, userC);
        await insertHome(database.pool, { id: homeId, name: 'Stale Actor' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId,
          userId: userB,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipC,
          homeId,
          userId: userC,
          role: 'ROOMMATE',
        });

        const change = createRoleChange(database.pool);
        await change({
          actor: actor({
            userId: userB,
            membershipId: membershipB,
            homeId,
            role: 'ADMIN',
          }),
          homeId,
          membershipId: membershipA,
          role: 'ROOMMATE',
        });

        const remove = createCommand(database.pool);
        await assert.rejects(
          () =>
            remove({
              actor: actor({
                userId: userA,
                membershipId: membershipA,
                homeId,
                role: 'ADMIN',
              }),
              homeId,
              membershipId: membershipC,
            }),
          ForbiddenError,
        );

        const rows = await membershipRows(database.pool, homeId);
        assert.equal(
          rows.find((row) => row.id === membershipC)?.ended_at,
          null,
        );
        assert.deepEqual(await endedEvents(database.pool, homeId), []);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userA, userB, userC],
        });
        await database.close();
      }
    },
  );

  void it(
    'serializes reciprocal Admin removal to one success and one concealed actor',
    { skip: skipWithoutDatabase, timeout: 20_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const membershipB = randomUUID();

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, {
          id: homeId,
          name: 'Reciprocal Remove',
        });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId,
          userId: userB,
          role: 'ADMIN',
        });

        const remove = createCommand(database.pool);
        const results = await Promise.allSettled([
          remove({
            actor: actor({
              userId: userA,
              membershipId: membershipA,
              homeId,
              role: 'ADMIN',
            }),
            homeId,
            membershipId: membershipB,
          }),
          remove({
            actor: actor({
              userId: userB,
              membershipId: membershipB,
              homeId,
              role: 'ADMIN',
            }),
            homeId,
            membershipId: membershipA,
          }),
        ]);

        const fulfilled = results.filter(
          (result) => result.status === 'fulfilled',
        );
        const rejected = results.filter(
          (result) => result.status === 'rejected',
        );
        assert.equal(fulfilled.length, 1);
        assert.equal(rejected.length, 1);
        assert.ok(
          rejected[0]?.status === 'rejected' &&
            rejected[0].reason instanceof ConcealedNotFoundError,
        );
        assert.ok(
          rejected[0]?.status === 'rejected' &&
            !(rejected[0].reason instanceof ForbiddenError) &&
            !(rejected[0].reason instanceof LastAdminRequiredError),
        );

        const rows = await membershipRows(database.pool, homeId);
        const stillActive = rows.filter((row) => row.ended_at === null);
        assert.equal(stillActive.length, 1);
        assert.equal(stillActive[0]?.role, 'ADMIN');
        assert.equal(await archivedAt(database.pool, homeId), null);
        assert.equal((await endedEvents(database.pool, homeId)).length, 1);
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
    'serializes two Admins removing the same Roommate to one success and one conceal',
    { skip: skipWithoutDatabase, timeout: 20_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const userC = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const membershipB = randomUUID();
      const membershipC = randomUUID();

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertUser(database.pool, userC);
        await insertHome(database.pool, {
          id: homeId,
          name: 'Same Target Remove',
        });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId,
          userId: userB,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipC,
          homeId,
          userId: userC,
          role: 'ROOMMATE',
        });

        const remove = createCommand(database.pool);
        const results = await Promise.allSettled([
          remove({
            actor: actor({
              userId: userA,
              membershipId: membershipA,
              homeId,
              role: 'ADMIN',
            }),
            homeId,
            membershipId: membershipC,
          }),
          remove({
            actor: actor({
              userId: userB,
              membershipId: membershipB,
              homeId,
              role: 'ADMIN',
            }),
            homeId,
            membershipId: membershipC,
          }),
        ]);

        const fulfilled = results.filter(
          (result) => result.status === 'fulfilled',
        );
        const rejected = results.filter(
          (result) => result.status === 'rejected',
        );
        assert.equal(fulfilled.length, 1);
        assert.equal(rejected.length, 1);
        assert.ok(
          rejected[0]?.status === 'rejected' &&
            rejected[0].reason instanceof ConcealedNotFoundError,
        );

        const rows = await membershipRows(database.pool, homeId);
        assert.ok(
          rows.find((row) => row.id === membershipC)?.ended_at instanceof Date,
        );
        assert.equal(
          rows.find((row) => row.id === membershipA)?.ended_at,
          null,
        );
        assert.equal(
          rows.find((row) => row.id === membershipB)?.ended_at,
          null,
        );
        assert.deepEqual(await endedEvents(database.pool, homeId), [
          { membershipId: membershipC, cause: 'ADMIN_REMOVAL' },
        ]);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userA, userB, userC],
        });
        await database.close();
      }
    },
  );

  void it(
    'serializes remove against role change from locked current state, not stale request roles',
    { skip: skipWithoutDatabase, timeout: 20_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const membershipB = randomUUID();

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, {
          id: homeId,
          name: 'Remove vs Role',
        });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId,
          userId: userB,
          role: 'ADMIN',
        });

        const remove = createCommand(database.pool);
        const change = createRoleChange(database.pool);
        const results = await Promise.allSettled([
          remove({
            actor: actor({
              userId: userA,
              membershipId: membershipA,
              homeId,
              role: 'ADMIN',
            }),
            homeId,
            membershipId: membershipB,
          }),
          change({
            actor: actor({
              userId: userB,
              membershipId: membershipB,
              homeId,
              role: 'ADMIN',
            }),
            homeId,
            membershipId: membershipA,
            role: 'ROOMMATE',
          }),
        ]);

        const fulfilled = results.filter(
          (result) => result.status === 'fulfilled',
        );
        const rejected = results.filter(
          (result) => result.status === 'rejected',
        );
        assert.equal(fulfilled.length, 1);
        assert.equal(rejected.length, 1);
        assert.ok(
          rejected[0]?.status === 'rejected' &&
            (rejected[0].reason instanceof ConcealedNotFoundError ||
              rejected[0].reason instanceof ForbiddenError),
        );

        const rows = await membershipRows(database.pool, homeId);
        const stillActive = rows.filter((row) => row.ended_at === null);
        assert.ok(stillActive.length >= 1);
        assert.ok(stillActive.some((row) => row.role === 'ADMIN'));
        assert.equal(
          (await endedEvents(database.pool, homeId)).length <= 1,
          true,
        );
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
    'rolls back when Task cleanup fails through the ending seam',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const membershipB = randomUUID();

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeId, name: 'Task Fail' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId,
          userId: userB,
          role: 'ROOMMATE',
        });

        const remove = createCommand(database.pool, {
          endMembership: createEndMembershipWithinHomeStructure({
            taskCleanup: {
              handleMembershipEnded() {
                return Promise.reject(
                  new Error('injected task cleanup failure'),
                );
              },
            },
            supplyCleanup: {
              handleMembershipEnded() {
                return Promise.resolve();
              },
            },
            membershipEnding: createMembershipEndingWriter(),
            outbox: createOutboxWriter(),
            ids: { next: nextEventId },
          }),
        });

        await assert.rejects(
          () =>
            remove({
              actor: actor({
                userId: userA,
                membershipId: membershipA,
                homeId,
                role: 'ADMIN',
              }),
              homeId,
              membershipId: membershipB,
            }),
          /injected task cleanup failure/,
        );

        const rows = await membershipRows(database.pool, homeId);
        assert.equal(
          rows.find((row) => row.id === membershipB)?.ended_at,
          null,
        );
        assert.deepEqual(await endedEvents(database.pool, homeId), []);
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
    'rolls back Task-marker writes when Supply cleanup fails through the seam',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const membershipB = randomUUID();

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeId, name: 'Supply Fail' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId,
          userId: userB,
          role: 'ROOMMATE',
        });

        const before = await database.pool.query<{ updated_at: Date }>(
          'SELECT updated_at FROM homes WHERE id = $1',
          [homeId],
        );

        const remove = createCommand(database.pool, {
          endMembership: createEndMembershipWithinHomeStructure({
            taskCleanup: {
              async handleMembershipEnded(tx, input) {
                await tx.query(
                  'UPDATE homes SET updated_at = $1 WHERE id = $2',
                  [TASK_MARKER_AT, input.homeId],
                );
              },
            },
            supplyCleanup: {
              handleMembershipEnded() {
                return Promise.reject(
                  new Error('injected supply cleanup failure'),
                );
              },
            },
            membershipEnding: createMembershipEndingWriter(),
            outbox: createOutboxWriter(),
            ids: { next: nextEventId },
          }),
        });

        await assert.rejects(
          () =>
            remove({
              actor: actor({
                userId: userA,
                membershipId: membershipA,
                homeId,
                role: 'ADMIN',
              }),
              homeId,
              membershipId: membershipB,
            }),
          /injected supply cleanup failure/,
        );

        const after = await database.pool.query<{ updated_at: Date }>(
          'SELECT updated_at FROM homes WHERE id = $1',
          [homeId],
        );
        assert.equal(
          after.rows[0]?.updated_at.getTime(),
          before.rows[0]?.updated_at.getTime(),
        );
        const rows = await membershipRows(database.pool, homeId);
        assert.equal(
          rows.find((row) => row.id === membershipB)?.ended_at,
          null,
        );
        assert.deepEqual(await endedEvents(database.pool, homeId), []);
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
    'rolls back remove when outbox append fails through the seam',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const membershipB = randomUUID();

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeId, name: 'Outbox Fail' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId,
          userId: userB,
          role: 'ROOMMATE',
        });

        const remove = createCommand(database.pool, {
          endMembership: createEndMembershipWithinHomeStructure({
            taskCleanup: {
              handleMembershipEnded() {
                return Promise.resolve();
              },
            },
            supplyCleanup: {
              handleMembershipEnded() {
                return Promise.resolve();
              },
            },
            membershipEnding: createMembershipEndingWriter(),
            outbox: {
              append() {
                return Promise.reject(new Error('injected outbox failure'));
              },
            },
            ids: { next: nextEventId },
          }),
        });

        await assert.rejects(
          () =>
            remove({
              actor: actor({
                userId: userA,
                membershipId: membershipA,
                homeId,
                role: 'ADMIN',
              }),
              homeId,
              membershipId: membershipB,
            }),
          /injected outbox failure/,
        );

        const rows = await membershipRows(database.pool, homeId);
        assert.equal(
          rows.find((row) => row.id === membershipB)?.ended_at,
          null,
        );
        assert.deepEqual(await endedEvents(database.pool, homeId), []);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userA, userB],
        });
        await database.close();
      }
    },
  );
});
