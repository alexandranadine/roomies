import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { lockHomeAndExactMemberships } from '../../domains/homes/lock-home-and-exact-memberships.js';
import { MaintenancePersistenceError } from '../../domains/maintenance/errors.js';
import { createMaintenanceRepository } from '../../domains/maintenance/repository.js';
import { findActiveExactMembershipIdsInHome } from '../../domains/memberships/find-active-exact-membership-ids-in-home.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  InvalidRequestError,
} from '../../platform/authz/errors.js';
import type { AppConfig } from '../../platform/config/types.js';
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
import { systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import { systemClock } from '../../platform/time/clock.js';
import {
  createCreateMaintenanceEntry,
  createCreateMaintenanceEntryFromPool,
} from './create-maintenance-entry.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  if (input.homeIds.length > 0) {
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
    await pool.query('DELETE FROM memberships WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query('DELETE FROM homes WHERE id = ANY($1)', [input.homeIds]);
  }
  if (input.userIds.length > 0) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [input.userIds]);
  }
}

async function entryCount(pool: Pool, homeId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM maintenance_entries WHERE home_id = $1`,
    [homeId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function audienceRows(
  pool: Pool,
  maintenanceEntryId: string,
): Promise<
  readonly { membership_id: string; created_at: Date; home_id: string }[]
> {
  const result = await pool.query<{
    membership_id: string;
    created_at: Date;
    home_id: string;
  }>(
    `SELECT membership_id, created_at, home_id
     FROM maintenance_audiences
     WHERE maintenance_entry_id = $1
     ORDER BY membership_id ASC`,
    [maintenanceEntryId],
  );
  return result.rows;
}

void describe('Maintenance create PostgreSQL', () => {
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
    'persists HOUSEHOLD and PRIVATE create shapes with exact timestamps',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const create = createCreateMaintenanceEntryFromPool(database.pool);
      const repository = createMaintenanceRepository(database.pool);
      const userA = randomUUID();
      const userB = randomUUID();
      const userC = randomUUID();
      const homeId = createUuidV7();
      const actorId = createUuidV7();
      const recipientId = createUuidV7();
      const extraId = createUuidV7();

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertUser(database.pool, userC);
        await insertHome(database.pool, { id: homeId, name: 'Create home' });
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
        await insertMembership(database.pool, {
          id: extraId,
          homeId,
          userId: userC,
          role: 'ADMIN',
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
          title: 'Leaky faucet',
          details: 'Kitchen sink',
        });
        assert.match(household.id, UUID_V7);
        assert.equal(household.visibility, 'HOUSEHOLD');
        assert.equal(household.status, 'OPEN');
        assert.equal(household.createdByMembershipId, actorId);
        assert.equal(household.details, 'Kitchen sink');
        assert.equal('homeId' in household, false);
        assert.equal('audienceMembershipIds' in household, false);
        assert.equal(
          household.createdAt.getTime(),
          household.updatedAt.getTime(),
        );
        assert.deepEqual(await audienceRows(database.pool, household.id), []);

        const creatorOnly = await create({
          actor: roommate,
          homeId,
          visibility: 'PRIVATE',
          title: 'Creator only',
          audienceMembershipIds: [],
        });
        assert.equal(creatorOnly.visibility, 'PRIVATE');
        assert.equal('audienceMembershipIds' in creatorOnly, false);
        const creatorAudience = await audienceRows(
          database.pool,
          creatorOnly.id,
        );
        assert.deepEqual(
          creatorAudience.map((row) => row.membership_id),
          [actorId],
        );
        assert.equal(
          creatorAudience[0]?.created_at.getTime(),
          creatorOnly.createdAt.getTime(),
        );
        assert.equal(
          creatorOnly.createdAt.getTime(),
          creatorOnly.updatedAt.getTime(),
        );

        const multi = await create({
          actor: roommate,
          homeId,
          visibility: 'PRIVATE',
          title: 'Shared private',
          audienceMembershipIds: [recipientId, extraId, actorId, recipientId],
        });
        const multiAudience = await audienceRows(database.pool, multi.id);
        assert.deepEqual(
          multiAudience.map((row) => row.membership_id),
          [actorId, extraId, recipientId].sort((left, right) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        );
        for (const row of multiAudience) {
          assert.equal(row.created_at.getTime(), multi.createdAt.getTime());
          assert.equal(row.home_id, homeId);
        }

        assert.equal(
          (await repository.findVisibleByHomeAndId(homeId, multi.id, actorId))
            ?.id,
          multi.id,
        );
        assert.equal(
          (
            await repository.findVisibleByHomeAndId(
              homeId,
              multi.id,
              recipientId,
            )
          )?.id,
          multi.id,
        );
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
    'conceals invalid, foreign, ended, missing, and mixed PRIVATE audiences',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const create = createCreateMaintenanceEntryFromPool(database.pool);
      const userA = randomUUID();
      const userB = randomUUID();
      const homeA = createUuidV7();
      const homeB = createUuidV7();
      const actorA = createUuidV7();
      const endedA = createUuidV7();
      const activeRejoin = createUuidV7();
      const foreignB = createUuidV7();
      const missing = createUuidV7();

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
          id: endedA,
          homeId: homeA,
          userId: userB,
          role: 'ROOMMATE',
          ended: true,
        });
        await insertMembership(database.pool, {
          id: activeRejoin,
          homeId: homeA,
          userId: userB,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: foreignB,
          homeId: homeB,
          userId: userB,
          role: 'ADMIN',
        });

        const roommate = actor({
          userId: userA,
          membershipId: actorA,
          homeId: homeA,
          role: 'ROOMMATE',
        });

        const cases: readonly {
          title: string;
          audience: readonly string[];
        }[] = [
          { title: 'foreign', audience: [foreignB] },
          { title: 'ended', audience: [endedA] },
          { title: 'missing', audience: [missing] },
          { title: 'mixed-invalid', audience: [activeRejoin, missing] },
          { title: 'mixed-foreign', audience: [activeRejoin, foreignB] },
        ];

        for (const testCase of cases) {
          const before = await entryCount(database.pool, homeA);
          await assert.rejects(
            () =>
              create({
                actor: roommate,
                homeId: homeA,
                visibility: 'PRIVATE',
                title: testCase.title,
                audienceMembershipIds: testCase.audience,
              }),
            (error: unknown) => {
              assert.ok(error instanceof ConcealedNotFoundError);
              assert.equal(error.message, 'Not found');
              assert.doesNotMatch(
                error.message,
                /foreign|ended|missing|Membership|Home|owner|active/i,
              );
              return true;
            },
          );
          assert.equal(await entryCount(database.pool, homeA), before);
        }

        const rejoined = await create({
          actor: roommate,
          homeId: homeA,
          visibility: 'PRIVATE',
          title: 'New tenure',
          audienceMembershipIds: [activeRejoin],
        });
        assert.deepEqual(
          (await audienceRows(database.pool, rejoined.id)).map(
            (row) => row.membership_id,
          ),
          [actorA, activeRejoin].sort((left, right) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        );
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
    'rejects contradictory HOUSEHOLD payloads and cross-Home actors',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const create = createCreateMaintenanceEntryFromPool(database.pool);
      const userA = randomUUID();
      const userB = randomUUID();
      const homeA = createUuidV7();
      const homeB = createUuidV7();
      const actorA = createUuidV7();
      const actorB = createUuidV7();

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

        const roommateA = actor({
          userId: userA,
          membershipId: actorA,
          homeId: homeA,
          role: 'ROOMMATE',
        });

        await assert.rejects(
          () =>
            create({
              actor: roommateA,
              homeId: homeA,
              visibility: 'HOUSEHOLD',
              title: 'Has empty audience',
              audienceMembershipIds: [],
            }),
          InvalidRequestError,
        );
        await assert.rejects(
          () =>
            create({
              actor: roommateA,
              homeId: homeA,
              visibility: 'HOUSEHOLD',
              title: 'Has actor audience',
              audienceMembershipIds: [actorA],
            }),
          InvalidRequestError,
        );

        await assert.rejects(
          () =>
            create({
              actor: roommateA,
              homeId: homeB,
              visibility: 'HOUSEHOLD',
              title: 'Wrong home',
            }),
          (error: unknown) => {
            assert.ok(error instanceof ConcealedNotFoundError);
            assert.equal(error.message, 'Not found');
            assert.doesNotMatch(
              error.message,
              /foreign|wrong Home|Membership exists/i,
            );
            return true;
          },
        );

        await assert.rejects(
          () =>
            create({
              actor: roommateA,
              homeId: homeA,
              visibility: 'PRIVATE',
              title: 'Mixed homes',
              audienceMembershipIds: [actorA, actorB],
            }),
          (error: unknown) => {
            assert.ok(error instanceof ConcealedNotFoundError);
            assert.equal(error.message, 'Not found');
            return true;
          },
        );
        assert.equal(await entryCount(database.pool, homeA), 0);
        assert.equal(await entryCount(database.pool, homeB), 0);
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
    'rolls back when atomic insert fails or the transaction throws after insert',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const repository = createMaintenanceRepository(database.pool);
      const userId = randomUUID();
      const homeId = createUuidV7();
      const actorId = createUuidV7();
      const missing = createUuidV7();

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, { id: homeId, name: 'Rollback home' });
        await insertMembership(database.pool, {
          id: actorId,
          homeId,
          userId,
          role: 'ADMIN',
        });

        await assert.rejects(
          () =>
            runInReadCommittedTransaction(database.pool, (tx) =>
              repository.insertEntryWithAudience(tx, {
                entry: {
                  id: createUuidV7(),
                  homeId,
                  createdByMembershipId: actorId,
                  visibility: 'PRIVATE',
                  title: 'Broken FK',
                  details: null,
                  status: 'OPEN',
                  resolvedByMembershipId: null,
                  resolvedAt: null,
                  createdAt: new Date('2026-09-13T18:00:00.000Z'),
                  updatedAt: new Date('2026-09-13T18:00:00.000Z'),
                },
                audienceMembershipIds: [actorId, missing],
              }),
            ),
          MaintenancePersistenceError,
        );
        assert.equal(await entryCount(database.pool, homeId), 0);

        const createThenThrow = createCreateMaintenanceEntry({
          runTransaction: (work) =>
            runInReadCommittedTransaction(database.pool, async (tx) => {
              await work(tx);
              throw new Error('injected failure after insert');
            }),
          lockHomeAndExactMemberships,
          findActiveExactMembershipIdsInHome,
          maintenance: repository,
          clock: systemClock,
          ids: systemUuidV7,
        });

        await assert.rejects(
          () =>
            createThenThrow({
              actor: actor({
                userId,
                membershipId: actorId,
                homeId,
                role: 'ADMIN',
              }),
              homeId,
              visibility: 'PRIVATE',
              title: 'Should roll back',
              audienceMembershipIds: [],
            }),
          /injected failure after insert/,
        );
        assert.equal(await entryCount(database.pool, homeId), 0);
        const leftoverAudience = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM maintenance_audiences WHERE home_id = $1`,
          [homeId],
        );
        assert.equal(Number(leftoverAudience.rows[0]?.count ?? '0'), 0);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userId],
        });
        await database.close();
      }
    },
  );
});
