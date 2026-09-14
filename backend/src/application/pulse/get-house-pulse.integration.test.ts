import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Temporal } from '@js-temporal/polyfill';
import type { Pool } from 'pg';
import { findHousePulseSnapshot } from '../../domains/homes/find-house-pulse-snapshot.js';
import {
  createMaintenanceRepository,
  type NewMaintenanceEntry,
} from '../../domains/maintenance/repository.js';
import {
  housePulseDtoSchema,
  toHousePulseDto,
} from '../../domains/pulse/house-pulse-dto.js';
import { createSupplyRepository } from '../../domains/supplies/repository.js';
import { homeLocalDateFromInstant } from '../../domains/tasks/home-local-date.js';
import { createTaskRepository } from '../../domains/tasks/repository.js';
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
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import { createGetHousePulseFromPool } from './get-house-pulse.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const OCCURRED = new Date('2026-09-13T12:00:00.000Z');

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
  input: { id: string; name: string; timezone?: string; archived?: boolean },
): Promise<void> {
  await pool.query(
    `INSERT INTO homes (id, name, timezone, archived_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [
      input.id,
      input.name,
      input.timezone ?? 'America/Los_Angeles',
      input.archived === true ? new Date() : null,
    ],
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
  input: { userIds: string[]; homeIds: string[] },
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
    await pool.query('DELETE FROM supply_claims WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query('DELETE FROM supply_entries WHERE home_id = ANY($1)', [
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
    await pool.query('DELETE FROM task_instances WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query('DELETE FROM task_definitions WHERE home_id = ANY($1)', [
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
    await pool.query('DELETE FROM homes WHERE id = ANY($1)', [input.homeIds]);
  }
  if (input.userIds.length > 0) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [input.userIds]);
  }
}

function actor(
  homeId: string,
  membershipId: string,
  userId: string,
  role: ActiveHomeActor['role'],
): ActiveHomeActor {
  return { userId, membershipId, homeId, role };
}

function maintenanceEntry(
  id: string,
  homeId: string,
  createdByMembershipId: string,
  visibility: 'HOUSEHOLD' | 'PRIVATE',
  title: string,
): NewMaintenanceEntry {
  return {
    id,
    homeId,
    createdByMembershipId,
    visibility,
    title,
    details: `${title} details`,
    status: 'OPEN',
    resolvedByMembershipId: null,
    resolvedAt: null,
    createdAt: OCCURRED,
    updatedAt: OCCURRED,
  };
}

void describe('getHousePulse PostgreSQL', () => {
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
    'returns a three-section snapshot with privacy-stable Maintenance counts',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const databaseUrl = resolveSafeDedicatedTestDatabaseUrl();
      const database = createDatabasePool(testConfig(databaseUrl));
      const getHousePulse = createGetHousePulseFromPool(database.pool);
      const tasks = createTaskRepository(database.pool);
      const supplies = createSupplyRepository(database.pool);
      const maintenance = createMaintenanceRepository(database.pool);
      const userIds: string[] = [];
      const homeIds: string[] = [];
      const logs: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        logs.push(args.map((value) => JSON.stringify(value)).join(' '));
      };

      try {
        const homeId = createUuidV7();
        const otherHome = createUuidV7();
        const archivedHome = createUuidV7();
        const alexUser = createUuidV7();
        const jamieUser = createUuidV7();
        const taylorUser = createUuidV7();
        const alex = createUuidV7();
        const jamie = createUuidV7();
        const taylor = createUuidV7();
        const stale = createUuidV7();
        homeIds.push(homeId, otherHome, archivedHome);
        userIds.push(alexUser, jamieUser, taylorUser);

        await insertUser(database.pool, alexUser);
        await insertUser(database.pool, jamieUser);
        await insertUser(database.pool, taylorUser);
        await insertHome(database.pool, {
          id: homeId,
          name: 'Pulse Home',
          timezone: 'America/Los_Angeles',
        });
        await insertHome(database.pool, { id: otherHome, name: 'Other' });
        await insertHome(database.pool, {
          id: archivedHome,
          name: 'Archived',
          archived: true,
        });
        await insertMembership(database.pool, {
          id: alex,
          homeId,
          userId: alexUser,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: jamie,
          homeId,
          userId: jamieUser,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: taylor,
          homeId,
          userId: taylorUser,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: stale,
          homeId,
          userId: alexUser,
          role: 'ROOMMATE',
          ended: true,
        });

        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await tasks.insertManual(tx, {
            id: createUuidV7(),
            homeId,
            title: 'Alex task',
            scheduledFor: null,
            assignedMembershipId: alex,
            createdAt: OCCURRED,
          });
          await supplies.insertSupplyEntry(tx, {
            id: createUuidV7(),
            homeId,
            title: 'Paper towels',
            status: 'OPEN',
            createdByMembershipId: alex,
            obtainedAt: null,
            obtainedByMembershipId: null,
            canceledAt: null,
            createdAt: OCCURRED,
            updatedAt: OCCURRED,
          });
          await maintenance.insertEntryWithAudience(tx, {
            entry: maintenanceEntry(
              createUuidV7(),
              homeId,
              taylor,
              'HOUSEHOLD',
              'H1',
            ),
            audienceMembershipIds: [],
          });
          await maintenance.insertEntryWithAudience(tx, {
            entry: maintenanceEntry(
              createUuidV7(),
              homeId,
              alex,
              'PRIVATE',
              'A1',
            ),
            audienceMembershipIds: [alex],
          });
          await maintenance.insertEntryWithAudience(tx, {
            entry: maintenanceEntry(
              createUuidV7(),
              homeId,
              jamie,
              'PRIVATE',
              'J1',
            ),
            audienceMembershipIds: [jamie],
          });
        });

        const alexPulse = await getHousePulse({
          actor: actor(homeId, alex, alexUser, 'ROOMMATE'),
          homeId,
        });
        const jamiePulse = await getHousePulse({
          actor: actor(homeId, jamie, jamieUser, 'ROOMMATE'),
          homeId,
        });
        const taylorPulse = await getHousePulse({
          actor: actor(homeId, taylor, taylorUser, 'ADMIN'),
          homeId,
        });

        assert.equal(alexPulse.items.length, 3);
        assert.deepEqual(
          alexPulse.items.map((item) => item.type),
          ['TASKS', 'SUPPLIES', 'MAINTENANCE'],
        );
        assert.equal(alexPulse.items[0]?.assignedOpenCount, 1);
        assert.equal(alexPulse.items[1]?.openCount, 1);
        assert.equal(alexPulse.items[2]?.openVisibleCount, 2);
        assert.equal(jamiePulse.items[2]?.openVisibleCount, 2);
        assert.equal(taylorPulse.items[2]?.openVisibleCount, 1);
        assert.equal(alexPulse.items[0]?.state, 'ACTIVE');
        assert.equal(alexPulse.items[1]?.state, 'ACTIVE');
        assert.equal(taylorPulse.items[2]?.state, 'ACTIVE');

        const snapshot = await runInReadCommittedTransaction(
          database.pool,
          (tx) =>
            findHousePulseSnapshot(tx, {
              homeId,
              requesterMembershipId: alex,
            }),
        );
        assert.ok(snapshot);
        assert.equal(
          alexPulse.homeLocalDate,
          homeLocalDateFromInstant(
            Temporal.Instant.from(alexPulse.generatedAt.toISOString()),
            snapshot.timezone,
          ),
        );
        assert.equal(snapshot.timezone, 'America/Los_Angeles');

        const alexDto = toHousePulseDto(alexPulse);
        housePulseDtoSchema.parse(alexDto);
        const serialized = JSON.stringify(alexDto);
        assert.equal(serialized.includes(alex), false);
        assert.equal(serialized.includes(homeId), false);
        assert.equal(serialized.includes('Alex'), false);
        assert.equal(serialized.includes('H1'), false);
        assert.equal(serialized.includes('details'), false);
        assert.equal(/score|rank|blame|unread/i.test(serialized), false);

        await runInReadCommittedTransaction(database.pool, async (tx) => {
          for (let index = 0; index < 6; index += 1) {
            await maintenance.insertEntryWithAudience(tx, {
              entry: maintenanceEntry(
                createUuidV7(),
                homeId,
                jamie,
                'PRIVATE',
                `HIDDEN-PRIVATE-JAMIE-${index}`,
              ),
              audienceMembershipIds: [jamie],
            });
          }
        });

        const alexAgain = await getHousePulse({
          actor: actor(homeId, alex, alexUser, 'ROOMMATE'),
          homeId,
        });
        const jamieAgain = await getHousePulse({
          actor: actor(homeId, jamie, jamieUser, 'ROOMMATE'),
          homeId,
        });
        const taylorAgain = await getHousePulse({
          actor: actor(homeId, taylor, taylorUser, 'ADMIN'),
          homeId,
        });
        const alexWithoutTime = {
          ...toHousePulseDto(alexAgain),
          generatedAt: '',
        };
        const alexOriginalWithoutTime = {
          ...toHousePulseDto(alexPulse),
          generatedAt: '',
        };
        assert.deepEqual(alexWithoutTime, alexOriginalWithoutTime);
        assert.equal(jamieAgain.items[2]?.openVisibleCount, 8);
        assert.deepEqual(
          { ...toHousePulseDto(taylorAgain), generatedAt: '' },
          { ...toHousePulseDto(taylorPulse), generatedAt: '' },
        );
        assert.equal(
          logs.some((line) => line.includes('HIDDEN-PRIVATE-JAMIE')),
          false,
        );

        await assert.rejects(
          () =>
            getHousePulse({
              actor: actor(homeId, stale, alexUser, 'ROOMMATE'),
              homeId,
            }),
          ConcealedNotFoundError,
        );
        await assert.rejects(
          () =>
            getHousePulse({
              actor: actor(otherHome, alex, alexUser, 'ROOMMATE'),
              homeId: otherHome,
            }),
          ConcealedNotFoundError,
        );
      } finally {
        console.error = originalError;
        await cleanup(database.pool, { userIds, homeIds });
        await database.close();
      }
    },
  );
});
