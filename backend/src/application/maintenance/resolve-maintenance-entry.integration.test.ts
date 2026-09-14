import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createLeaveMembershipFromPool } from '../home-administration/leave-membership.js';
import { lockHomeAndExactMemberships } from '../../domains/homes/lock-home-and-exact-memberships.js';
import {
  MaintenanceNotOpenError,
  MaintenancePersistenceError,
} from '../../domains/maintenance/errors.js';
import { createMaintenanceRepository } from '../../domains/maintenance/repository.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import type { AppConfig } from '../../platform/config/types.js';
import { outboxWriter } from '../../platform/events/outbox-writer.js';
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
import { systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import { createCreateMaintenanceEntryFromPool } from './create-maintenance-entry.js';
import {
  createResolveMaintenanceEntry,
  createResolveMaintenanceEntryFromPool,
} from './resolve-maintenance-entry.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const CREATED = new Date('2026-09-13T12:00:00.000Z');
const OCCURRED = new Date('2026-09-13T18:00:00.000Z');

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
    await pool.query('DELETE FROM invitations WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
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

async function insertOpenEntry(
  pool: Pool,
  input: {
    id: string;
    homeId: string;
    createdByMembershipId: string;
    visibility: 'HOUSEHOLD' | 'PRIVATE';
    title: string;
    audienceMembershipIds: readonly string[];
  },
): Promise<void> {
  const repository = createMaintenanceRepository(pool);
  await runInReadCommittedTransaction(pool, async (tx) => {
    await repository.insertEntryWithAudience(tx, {
      entry: {
        id: input.id,
        homeId: input.homeId,
        createdByMembershipId: input.createdByMembershipId,
        visibility: input.visibility,
        title: input.title,
        details: null,
        status: 'OPEN',
        resolvedByMembershipId: null,
        resolvedAt: null,
        createdAt: CREATED,
        updatedAt: CREATED,
      },
      audienceMembershipIds: input.audienceMembershipIds,
    });
  });
}

type EntryRow = {
  status: string;
  resolved_by_membership_id: string | null;
  resolved_at: Date | null;
  updated_at: Date;
  created_at: Date;
  created_by_membership_id: string;
  visibility: string;
  title: string;
  details: string | null;
  home_id: string;
};

async function entryRow(pool: Pool, id: string): Promise<EntryRow> {
  const result = await pool.query<EntryRow>(
    `SELECT status, resolved_by_membership_id, resolved_at, updated_at,
            created_at, created_by_membership_id, visibility, title, details, home_id
     FROM maintenance_entries WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('maintenance entry was missing');
  }
  return row;
}

async function maintenanceOutboxCount(
  pool: Pool,
  homeIds: readonly string[],
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM outbox_events
     WHERE home_id = ANY($1::uuid[])
       AND event_type LIKE 'maintenance%'`,
    [homeIds],
  );
  return Number(result.rows[0]?.count ?? '0');
}

function countingClock() {
  let calls = 0;
  return {
    now() {
      calls += 1;
      return OCCURRED;
    },
    calls: () => calls,
  };
}

function resolveWithClock(pool: Pool, clock: { now: () => Date }) {
  return createResolveMaintenanceEntry({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeAndExactMemberships,
    maintenance: createMaintenanceRepository(pool),
    outbox: outboxWriter,
    clock,
    ids: systemUuidV7,
  });
}

void describe('Maintenance resolve PostgreSQL', () => {
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
    'enforces the Alex/Jamie/Taylor privacy sentinel on resolve',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const resolve = createResolveMaintenanceEntryFromPool(database.pool);
      const userAlex = randomUUID();
      const userJamie = randomUUID();
      const userTaylor = randomUUID();
      const homeId = createUuidV7();
      const alex = createUuidV7();
      const jamie = createUuidV7();
      const taylor = createUuidV7();
      const privateA = createUuidV7();
      const privateA2 = createUuidV7();
      const privateB = createUuidV7();
      const privateB2 = createUuidV7();
      const householdH = createUuidV7();
      const alexActor = actor({
        userId: userAlex,
        membershipId: alex,
        homeId,
        role: 'ROOMMATE',
      });
      const jamieActor = actor({
        userId: userJamie,
        membershipId: jamie,
        homeId,
        role: 'ROOMMATE',
      });
      const taylorActor = actor({
        userId: userTaylor,
        membershipId: taylor,
        homeId,
        role: 'ADMIN',
      });

      try {
        await insertUser(database.pool, userAlex);
        await insertUser(database.pool, userJamie);
        await insertUser(database.pool, userTaylor);
        await insertHome(database.pool, { id: homeId, name: 'Sentinel' });
        await insertMembership(database.pool, {
          id: alex,
          homeId,
          userId: userAlex,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: jamie,
          homeId,
          userId: userJamie,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: taylor,
          homeId,
          userId: userTaylor,
          role: 'ADMIN',
        });
        await insertOpenEntry(database.pool, {
          id: privateA,
          homeId,
          createdByMembershipId: alex,
          visibility: 'PRIVATE',
          title: 'Private A',
          audienceMembershipIds: [alex],
        });
        await insertOpenEntry(database.pool, {
          id: privateA2,
          homeId,
          createdByMembershipId: alex,
          visibility: 'PRIVATE',
          title: 'Private A 2',
          audienceMembershipIds: [alex],
        });
        await insertOpenEntry(database.pool, {
          id: privateB,
          homeId,
          createdByMembershipId: jamie,
          visibility: 'PRIVATE',
          title: 'Private B',
          audienceMembershipIds: [jamie],
        });
        await insertOpenEntry(database.pool, {
          id: privateB2,
          homeId,
          createdByMembershipId: jamie,
          visibility: 'PRIVATE',
          title: 'Private B 2',
          audienceMembershipIds: [jamie],
        });
        await insertOpenEntry(database.pool, {
          id: householdH,
          homeId,
          createdByMembershipId: taylor,
          visibility: 'HOUSEHOLD',
          title: 'Household H',
          audienceMembershipIds: [],
        });

        const alexResolved = await resolve({
          actor: alexActor,
          homeId,
          maintenanceEntryId: privateA,
        });
        assert.equal(alexResolved.status, 'RESOLVED');
        assert.equal(alexResolved.resolvedByMembershipId, alex);
        assert.notEqual(alexResolved.resolvedAt, null);
        assert.equal(
          alexResolved.updatedAt.toISOString(),
          alexResolved.resolvedAt?.toISOString(),
        );
        await assert.rejects(
          () =>
            resolve({
              actor: alexActor,
              homeId,
              maintenanceEntryId: privateB,
            }),
          ConcealedNotFoundError,
        );
        assert.equal((await entryRow(database.pool, privateB)).status, 'OPEN');

        const jamieResolved = await resolve({
          actor: jamieActor,
          homeId,
          maintenanceEntryId: privateB,
        });
        assert.equal(jamieResolved.status, 'RESOLVED');
        assert.equal(jamieResolved.resolvedByMembershipId, jamie);
        await assert.rejects(
          () =>
            resolve({
              actor: jamieActor,
              homeId,
              maintenanceEntryId: privateA2,
            }),
          ConcealedNotFoundError,
        );
        assert.equal((await entryRow(database.pool, privateA2)).status, 'OPEN');

        const household = await resolve({
          actor: taylorActor,
          homeId,
          maintenanceEntryId: householdH,
        });
        assert.equal(household.status, 'RESOLVED');
        assert.equal(household.resolvedByMembershipId, taylor);
        await assert.rejects(
          () =>
            resolve({
              actor: taylorActor,
              homeId,
              maintenanceEntryId: privateA2,
            }),
          ConcealedNotFoundError,
        );
        await assert.rejects(
          () =>
            resolve({
              actor: taylorActor,
              homeId,
              maintenanceEntryId: privateB2,
            }),
          ConcealedNotFoundError,
        );
        assert.equal((await entryRow(database.pool, privateA2)).status, 'OPEN');
        assert.equal((await entryRow(database.pool, privateB2)).status, 'OPEN');
        const outbox = await database.pool.query<{
          event_type: string;
          payload: unknown;
        }>(
          `SELECT event_type, payload FROM outbox_events
           WHERE home_id = $1 AND event_type LIKE 'maintenance%'
           ORDER BY created_at ASC`,
          [homeId],
        );
        assert.equal(outbox.rows.length, 3);
        assert.deepEqual(
          outbox.rows.map((row) => row.event_type),
          [
            'maintenance.resolved.v1',
            'maintenance.resolved.v1',
            'maintenance.resolved.v1',
          ],
        );
        for (const row of outbox.rows) {
          assert.deepEqual(Object.keys(row.payload ?? {}), [
            'maintenanceEntryId',
          ]);
          const serialized = JSON.stringify(row.payload);
          assert.equal(serialized.includes('Private A'), false);
          assert.equal(serialized.includes('Private B'), false);
          assert.equal(serialized.includes('Household H'), false);
          assert.equal(serialized.includes(userAlex), false);
          assert.equal(serialized.includes(alex), false);
        }
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userAlex, userJamie, userTaylor],
        });
        await database.close();
      }
    },
  );

  void it(
    'conceals ended-tenure PRIVATE after rejoin and lets HOUSEHOLD resolve as the new Membership',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const create = createCreateMaintenanceEntryFromPool(database.pool);
      const resolve = createResolveMaintenanceEntryFromPool(database.pool);
      const leave = createLeaveMembershipFromPool(database.pool);
      const userA = randomUUID();
      const userAdmin = randomUUID();
      const homeId = createUuidV7();
      const membershipA = createUuidV7();
      const membershipB = createUuidV7();
      const adminId = createUuidV7();
      const actorA = actor({
        userId: userA,
        membershipId: membershipA,
        homeId,
        role: 'ROOMMATE',
      });
      const admin = actor({
        userId: userAdmin,
        membershipId: adminId,
        homeId,
        role: 'ADMIN',
      });

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userAdmin);
        await insertHome(database.pool, { id: homeId, name: 'Tenure' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: adminId,
          homeId,
          userId: userAdmin,
          role: 'ADMIN',
        });
        const privateEntry = await create({
          actor: actorA,
          homeId,
          visibility: 'PRIVATE',
          title: 'A-only private',
          audienceMembershipIds: [],
        });
        const household = await create({
          actor: admin,
          homeId,
          visibility: 'HOUSEHOLD',
          title: 'Shared household',
        });

        await leave({
          actor: actorA,
          homeId,
          membershipId: membershipA,
        });
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

        await assert.rejects(
          () =>
            resolve({
              actor: actorB,
              homeId,
              maintenanceEntryId: privateEntry.id,
            }),
          ConcealedNotFoundError,
        );
        const privateRow = await entryRow(database.pool, privateEntry.id);
        assert.equal(privateRow.status, 'OPEN');
        assert.equal(privateRow.resolved_by_membership_id, null);

        const resolvedHousehold = await resolve({
          actor: actorB,
          homeId,
          maintenanceEntryId: household.id,
        });
        assert.equal(resolvedHousehold.status, 'RESOLVED');
        assert.equal(resolvedHousehold.resolvedByMembershipId, membershipB);
        assert.notEqual(resolvedHousehold.resolvedByMembershipId, membershipA);
        assert.equal(
          resolvedHousehold.updatedAt.toISOString(),
          resolvedHousehold.resolvedAt?.toISOString(),
        );
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userA, userAdmin],
        });
        await database.close();
      }
    },
  );

  void it(
    'conflicts on a visible RESOLVED entry and conceals missing/foreign identically',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const resolve = createResolveMaintenanceEntryFromPool(database.pool);
      const userId = randomUUID();
      const homeId = createUuidV7();
      const otherHomeId = createUuidV7();
      const membershipId = createUuidV7();
      const otherMembership = createUuidV7();
      const otherUser = randomUUID();
      const entryId = createUuidV7();
      const foreignId = createUuidV7();
      const randomId = createUuidV7();
      const roommate = actor({
        userId,
        membershipId,
        homeId,
        role: 'ROOMMATE',
      });

      try {
        await insertUser(database.pool, userId);
        await insertUser(database.pool, otherUser);
        await insertHome(database.pool, { id: homeId, name: 'Conflict home' });
        await insertHome(database.pool, { id: otherHomeId, name: 'Other' });
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: otherMembership,
          homeId: otherHomeId,
          userId: otherUser,
          role: 'ADMIN',
        });
        await insertOpenEntry(database.pool, {
          id: entryId,
          homeId,
          createdByMembershipId: membershipId,
          visibility: 'HOUSEHOLD',
          title: 'To resolve twice',
          audienceMembershipIds: [],
        });
        await insertOpenEntry(database.pool, {
          id: foreignId,
          homeId: otherHomeId,
          createdByMembershipId: otherMembership,
          visibility: 'HOUSEHOLD',
          title: 'Foreign',
          audienceMembershipIds: [],
        });

        const first = await resolve({
          actor: roommate,
          homeId,
          maintenanceEntryId: entryId,
        });
        assert.equal(first.status, 'RESOLVED');
        await assert.rejects(
          () =>
            resolve({
              actor: roommate,
              homeId,
              maintenanceEntryId: entryId,
            }),
          (error: unknown) => {
            assert.ok(error instanceof MaintenanceNotOpenError);
            assert.equal(error.message, 'Maintenance is not open');
            return true;
          },
        );

        const missingShapes: Array<{ name: string; message: string }> = [];
        for (const maintenanceEntryId of [randomId, foreignId]) {
          await assert.rejects(
            () =>
              resolve({
                actor: roommate,
                homeId,
                maintenanceEntryId,
              }),
            (error: unknown) => {
              assert.ok(error instanceof ConcealedNotFoundError);
              assert.equal(error.message, 'Not found');
              missingShapes.push({
                name: error.name,
                message: error.message,
              });
              return true;
            },
          );
        }
        assert.deepEqual(missingShapes[0], missingShapes[1]);
        assert.equal((await entryRow(database.pool, foreignId)).status, 'OPEN');
        assert.equal(
          (await entryRow(database.pool, entryId)).status,
          'RESOLVED',
        );
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId, otherHomeId],
          userIds: [userId, otherUser],
        });
        await database.close();
      }
    },
  );

  void it(
    'conceals cross-Home resolve attempts without mutating the foreign row',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const resolve = createResolveMaintenanceEntryFromPool(database.pool);
      const userA = randomUUID();
      const userB = randomUUID();
      const homeA = createUuidV7();
      const homeB = createUuidV7();
      const actorA = createUuidV7();
      const actorB = createUuidV7();
      const entryA = createUuidV7();
      const entryB = createUuidV7();
      const roommateA = actor({
        userId: userA,
        membershipId: actorA,
        homeId: homeA,
        role: 'ROOMMATE',
      });
      const roommateB = actor({
        userId: userB,
        membershipId: actorB,
        homeId: homeB,
        role: 'ADMIN',
      });

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeA, name: 'Home A' });
        await insertHome(database.pool, { id: homeB, name: 'Home B' });
        await insertMembership(database.pool, {
          id: actorA,
          homeId: homeA,
          userId: userA,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: actorB,
          homeId: homeB,
          userId: userB,
          role: 'ADMIN',
        });
        await insertOpenEntry(database.pool, {
          id: entryA,
          homeId: homeA,
          createdByMembershipId: actorA,
          visibility: 'HOUSEHOLD',
          title: 'A entry',
          audienceMembershipIds: [],
        });
        await insertOpenEntry(database.pool, {
          id: entryB,
          homeId: homeB,
          createdByMembershipId: actorB,
          visibility: 'HOUSEHOLD',
          title: 'B entry',
          audienceMembershipIds: [],
        });

        const shapes: Array<{ name: string; message: string }> = [];
        await assert.rejects(
          () =>
            resolve({
              actor: roommateA,
              homeId: homeA,
              maintenanceEntryId: entryB,
            }),
          (error: unknown) => {
            assert.ok(error instanceof ConcealedNotFoundError);
            shapes.push({ name: error.name, message: error.message });
            return true;
          },
        );
        await assert.rejects(
          () =>
            resolve({
              actor: roommateA,
              homeId: homeB,
              maintenanceEntryId: entryB,
            }),
          (error: unknown) => {
            assert.ok(error instanceof ConcealedNotFoundError);
            shapes.push({ name: error.name, message: error.message });
            return true;
          },
        );
        await assert.rejects(
          () =>
            resolve({
              actor: roommateB,
              homeId: homeA,
              maintenanceEntryId: entryA,
            }),
          ConcealedNotFoundError,
        );
        assert.deepEqual(shapes[0], shapes[1]);
        assert.equal((await entryRow(database.pool, entryA)).status, 'OPEN');
        assert.equal((await entryRow(database.pool, entryB)).status, 'OPEN');
        assert.equal((await entryRow(database.pool, entryB)).home_id, homeB);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeA, homeB],
          userIds: [userA, userB],
        });
        await database.close();
      }
    },
  );

  void it(
    'reads Clock once on success and zero times on rejected paths',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const userId = randomUUID();
      const otherUser = randomUUID();
      const homeId = createUuidV7();
      const otherHomeId = createUuidV7();
      const archivedHome = createUuidV7();
      const membershipId = createUuidV7();
      const otherMembership = createUuidV7();
      const endedId = createUuidV7();
      const archivedMembership = createUuidV7();
      const openId = createUuidV7();
      const resolvedId = createUuidV7();
      const privateOther = createUuidV7();
      const foreignId = createUuidV7();
      const roommate = actor({
        userId,
        membershipId,
        homeId,
        role: 'ROOMMATE',
      });

      try {
        await insertUser(database.pool, userId);
        await insertUser(database.pool, otherUser);
        await insertHome(database.pool, { id: homeId, name: 'Clock home' });
        await insertHome(database.pool, { id: otherHomeId, name: 'Other' });
        await insertHome(database.pool, {
          id: archivedHome,
          name: 'Archived',
          archived: true,
        });
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: otherMembership,
          homeId: otherHomeId,
          userId: otherUser,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: endedId,
          homeId,
          userId,
          role: 'ROOMMATE',
          ended: true,
        });
        await insertMembership(database.pool, {
          id: archivedMembership,
          homeId: archivedHome,
          userId,
          role: 'ADMIN',
        });
        await insertOpenEntry(database.pool, {
          id: openId,
          homeId,
          createdByMembershipId: membershipId,
          visibility: 'HOUSEHOLD',
          title: 'Open',
          audienceMembershipIds: [],
        });
        await insertOpenEntry(database.pool, {
          id: resolvedId,
          homeId,
          createdByMembershipId: membershipId,
          visibility: 'HOUSEHOLD',
          title: 'Already resolved',
          audienceMembershipIds: [],
        });
        await insertOpenEntry(database.pool, {
          id: privateOther,
          homeId,
          createdByMembershipId: membershipId,
          visibility: 'PRIVATE',
          title: 'Hidden',
          audienceMembershipIds: [endedId],
        });
        await insertOpenEntry(database.pool, {
          id: foreignId,
          homeId: otherHomeId,
          createdByMembershipId: otherMembership,
          visibility: 'HOUSEHOLD',
          title: 'Foreign',
          audienceMembershipIds: [],
        });
        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await createMaintenanceRepository(database.pool).resolveOpenEntry(
            tx,
            {
              homeId,
              maintenanceEntryId: resolvedId,
              resolverMembershipId: membershipId,
              resolvedAt: CREATED,
            },
          );
        });

        const successClock = countingClock();
        const success = await resolveWithClock(
          database.pool,
          successClock,
        )({
          actor: roommate,
          homeId,
          maintenanceEntryId: openId,
        });
        assert.equal(success.status, 'RESOLVED');
        assert.equal(successClock.calls(), 1);
        assert.equal(success.resolvedAt?.toISOString(), OCCURRED.toISOString());
        assert.equal(success.updatedAt.toISOString(), OCCURRED.toISOString());

        const resolvedClock = countingClock();
        await assert.rejects(
          () =>
            resolveWithClock(
              database.pool,
              resolvedClock,
            )({
              actor: roommate,
              homeId,
              maintenanceEntryId: resolvedId,
            }),
          MaintenanceNotOpenError,
        );
        assert.equal(resolvedClock.calls(), 0);

        const invisibleClock = countingClock();
        await assert.rejects(
          () =>
            resolveWithClock(
              database.pool,
              invisibleClock,
            )({
              actor: roommate,
              homeId,
              maintenanceEntryId: createUuidV7(),
            }),
          ConcealedNotFoundError,
        );
        assert.equal(invisibleClock.calls(), 0);

        const invisibleClockPrivate = countingClock();
        await assert.rejects(
          () =>
            resolveWithClock(
              database.pool,
              invisibleClockPrivate,
            )({
              actor: roommate,
              homeId,
              maintenanceEntryId: privateOther,
            }),
          ConcealedNotFoundError,
        );
        assert.equal(invisibleClockPrivate.calls(), 0);

        const foreignClock = countingClock();
        await assert.rejects(
          () =>
            resolveWithClock(
              database.pool,
              foreignClock,
            )({
              actor: roommate,
              homeId,
              maintenanceEntryId: foreignId,
            }),
          ConcealedNotFoundError,
        );
        assert.equal(foreignClock.calls(), 0);

        const staleClock = countingClock();
        await assert.rejects(
          () =>
            resolveWithClock(
              database.pool,
              staleClock,
            )({
              actor: actor({
                userId,
                membershipId: endedId,
                homeId,
                role: 'ROOMMATE',
              }),
              homeId,
              maintenanceEntryId: privateOther,
            }),
          ConcealedNotFoundError,
        );
        assert.equal(staleClock.calls(), 0);

        const archivedClock = countingClock();
        await assert.rejects(
          () =>
            resolveWithClock(
              database.pool,
              archivedClock,
            )({
              actor: actor({
                userId,
                membershipId: archivedMembership,
                homeId: archivedHome,
                role: 'ADMIN',
              }),
              homeId: archivedHome,
              maintenanceEntryId: openId,
            }),
          ConcealedNotFoundError,
        );
        assert.equal(archivedClock.calls(), 0);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId, otherHomeId, archivedHome],
          userIds: [userId, otherUser],
        });
        await database.close();
      }
    },
  );

  void it(
    'rolls back Case A when the resolve write fails after a visible OPEN lock',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const maintenance = createMaintenanceRepository(database.pool);
      const userId = randomUUID();
      const homeId = createUuidV7();
      const membershipId = createUuidV7();
      const entryId = createUuidV7();
      const roommate = actor({
        userId,
        membershipId,
        homeId,
        role: 'ROOMMATE',
      });

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, { id: homeId, name: 'Rollback A' });
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ROOMMATE',
        });
        await insertOpenEntry(database.pool, {
          id: entryId,
          homeId,
          createdByMembershipId: membershipId,
          visibility: 'HOUSEHOLD',
          title: 'Case A',
          audienceMembershipIds: [],
        });
        const before = await entryRow(database.pool, entryId);

        await assert.rejects(
          () =>
            createResolveMaintenanceEntry({
              runTransaction: (work) =>
                runInReadCommittedTransaction(database.pool, work),
              lockHomeAndExactMemberships,
              maintenance: {
                lockVisibleForResolve: (tx, home, id, actorMembershipId) =>
                  maintenance.lockVisibleForResolve(
                    tx,
                    home,
                    id,
                    actorMembershipId,
                  ),
                resolveOpenEntry: () =>
                  Promise.reject(
                    new Error('force rollback before resolve write'),
                  ),
              },
              outbox: outboxWriter,
              clock: { now: () => OCCURRED },
              ids: systemUuidV7,
            })({
              actor: roommate,
              homeId,
              maintenanceEntryId: entryId,
            }),
          /force rollback before resolve write/,
        );

        const after = await entryRow(database.pool, entryId);
        assert.equal(after.status, 'OPEN');
        assert.equal(after.resolved_by_membership_id, null);
        assert.equal(after.resolved_at, null);
        assert.equal(after.updated_at.getTime(), before.updated_at.getTime());
        assert.equal(await maintenanceOutboxCount(database.pool, [homeId]), 0);

        await assert.rejects(
          () =>
            createResolveMaintenanceEntry({
              runTransaction: (work) =>
                runInReadCommittedTransaction(database.pool, work),
              lockHomeAndExactMemberships,
              maintenance: {
                lockVisibleForResolve: (tx, home, id, actorMembershipId) =>
                  maintenance.lockVisibleForResolve(
                    tx,
                    home,
                    id,
                    actorMembershipId,
                  ),
                resolveOpenEntry: () => Promise.resolve(null),
              },
              outbox: outboxWriter,
              clock: { now: () => OCCURRED },
              ids: systemUuidV7,
            })({
              actor: roommate,
              homeId,
              maintenanceEntryId: entryId,
            }),
          MaintenancePersistenceError,
        );
        const afterZero = await entryRow(database.pool, entryId);
        assert.equal(afterZero.status, 'OPEN');
        assert.equal(afterZero.resolved_by_membership_id, null);
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
    'rolls back Case B when resolve write succeeds then the transaction fails',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const maintenance = createMaintenanceRepository(database.pool);
      const userId = randomUUID();
      const homeId = createUuidV7();
      const membershipId = createUuidV7();
      const entryId = createUuidV7();
      const roommate = actor({
        userId,
        membershipId,
        homeId,
        role: 'ROOMMATE',
      });

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, { id: homeId, name: 'Rollback B' });
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ROOMMATE',
        });
        await insertOpenEntry(database.pool, {
          id: entryId,
          homeId,
          createdByMembershipId: membershipId,
          visibility: 'HOUSEHOLD',
          title: 'Case B',
          audienceMembershipIds: [],
        });
        const before = await entryRow(database.pool, entryId);

        await assert.rejects(
          () =>
            createResolveMaintenanceEntry({
              runTransaction: (work) =>
                runInReadCommittedTransaction(database.pool, work),
              lockHomeAndExactMemberships,
              maintenance: {
                lockVisibleForResolve: (tx, home, id, actorMembershipId) =>
                  maintenance.lockVisibleForResolve(
                    tx,
                    home,
                    id,
                    actorMembershipId,
                  ),
                resolveOpenEntry: async (tx, write) => {
                  await maintenance.resolveOpenEntry(tx, write);
                  throw new Error('force rollback before commit');
                },
              },
              outbox: outboxWriter,
              clock: { now: () => OCCURRED },
              ids: systemUuidV7,
            })({
              actor: roommate,
              homeId,
              maintenanceEntryId: entryId,
            }),
          /force rollback before commit/,
        );

        const after = await entryRow(database.pool, entryId);
        assert.deepEqual(after, before);
        assert.equal(after.status, 'OPEN');
        assert.equal(after.resolved_by_membership_id, null);
        assert.equal(after.resolved_at, null);
        assert.equal(await maintenanceOutboxCount(database.pool, [homeId]), 0);
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
    'keeps historical resolver attribution after the resolving Membership ends',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const resolve = createResolveMaintenanceEntryFromPool(database.pool);
      const leave = createLeaveMembershipFromPool(database.pool);
      const userA = randomUUID();
      const userAdmin = randomUUID();
      const homeId = createUuidV7();
      const membershipA = createUuidV7();
      const adminId = createUuidV7();
      const entryId = createUuidV7();
      const actorA = actor({
        userId: userA,
        membershipId: membershipA,
        homeId,
        role: 'ROOMMATE',
      });

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userAdmin);
        await insertHome(database.pool, { id: homeId, name: 'History' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: adminId,
          homeId,
          userId: userAdmin,
          role: 'ADMIN',
        });
        await insertOpenEntry(database.pool, {
          id: entryId,
          homeId,
          createdByMembershipId: membershipA,
          visibility: 'HOUSEHOLD',
          title: 'Resolved then left',
          audienceMembershipIds: [],
        });
        const resolved = await resolve({
          actor: actorA,
          homeId,
          maintenanceEntryId: entryId,
        });
        assert.equal(resolved.resolvedByMembershipId, membershipA);
        await leave({
          actor: actorA,
          homeId,
          membershipId: membershipA,
        });
        const row = await entryRow(database.pool, entryId);
        assert.equal(row.status, 'RESOLVED');
        assert.equal(row.resolved_by_membership_id, membershipA);
        assert.ok(row.resolved_at);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userA, userAdmin],
        });
        await database.close();
      }
    },
  );
});
