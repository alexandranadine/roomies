import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { lockHomeStructure } from '../../domains/homes/lock-home-structure.js';
import { StructuralIntegrityError } from '../../domains/homes/structure-errors.js';
import { createMembershipEndingWriter } from '../../domains/memberships/update-active-membership-ended-at.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import type { AppConfig } from '../../platform/config/types.js';
import { createOutboxWriter } from '../../platform/events/outbox-writer.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import {
  runInReadCommittedTransaction,
  type TransactionContext,
} from '../../platform/persistence/transaction.js';
import type { MembershipEndingCleanupInput } from './membership-ending-cleanup.js';
import { createEndMembershipWithinHomeStructure } from './end-membership-within-home-structure.js';
import { createMembershipEndingSupplyCleanupFromPool } from '../supplies/membership-ending-supply-cleanup.js';
import { createMembershipEndingTaskCleanupFromPool } from '../tasks/membership-ending-task-cleanup.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const ENDED_AT = new Date('2026-03-15T12:34:56.789Z');
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
    endedAt?: Date | null;
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
      input.endedAt === undefined ? null : input.endedAt,
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

type CleanupCall = {
  tx: TransactionContext;
  input: MembershipEndingCleanupInput;
};

function createEndingSeam(
  options: {
    taskError?: Error;
    supplyError?: Error;
    outboxError?: Error;
    writeTaskMarker?: boolean;
    updateRows?: number;
  } = {},
) {
  const taskCalls: CleanupCall[] = [];
  const supplyCalls: CleanupCall[] = [];
  const innerWriter = createMembershipEndingWriter();
  const endMembership = createEndMembershipWithinHomeStructure({
    taskCleanup: {
      async handleMembershipEnded(tx, input) {
        taskCalls.push({ tx, input });
        if (options.taskError) {
          throw options.taskError;
        }
        if (options.writeTaskMarker === true) {
          await tx.query('UPDATE homes SET updated_at = $1 WHERE id = $2', [
            TASK_MARKER_AT,
            input.homeId,
          ]);
        }
      },
    },
    supplyCleanup: {
      handleMembershipEnded(tx, input) {
        supplyCalls.push({ tx, input });
        if (options.supplyError) {
          return Promise.reject(options.supplyError);
        }
        return Promise.resolve();
      },
    },
    membershipEnding: {
      endActiveMembership(tx, input) {
        if (options.updateRows !== undefined) {
          return Promise.resolve(options.updateRows);
        }
        return innerWriter.endActiveMembership(tx, input);
      },
    },
    outbox: {
      append(tx, event) {
        if (options.outboxError) {
          return Promise.reject(options.outboxError);
        }
        return createOutboxWriter().append(tx, event);
      },
    },
    ids: { next: nextEventId },
  });
  return { endMembership, taskCalls, supplyCalls };
}

void describe('endMembershipWithinHomeStructure PostgreSQL', () => {
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
    'ends the locked exact tenure, invokes both ports, and commits membership.ended.v1',
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
      const { endMembership, taskCalls, supplyCalls } = createEndingSeam();

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeId, name: 'Ending Home' });
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

        const before = await database.pool.query<{
          id: string;
          role: string;
          joined_at: Date;
          ended_at: Date | null;
        }>(
          `SELECT id, role, joined_at, ended_at
           FROM memberships
           WHERE id = $1`,
          [membershipB],
        );
        const joinedAt = before.rows[0]?.joined_at;
        assert.ok(joinedAt instanceof Date);
        assert.equal(before.rows[0]?.ended_at, null);
        assert.equal(before.rows[0]?.role, 'ROOMMATE');

        const result = await runInReadCommittedTransaction(
          database.pool,
          async (tx) => {
            const locked = await lockHomeStructure(tx, {
              homeId,
              actor: actor({
                userId: userA,
                membershipId: membershipA,
                homeId,
                role: 'ADMIN',
              }),
            });
            const target = locked.activeMemberships.find(
              (membership) => membership.id === membershipB,
            );
            assert.ok(target);
            return endMembership(tx, {
              homeId: locked.home.id,
              membershipId: target.id,
              endedAt: ENDED_AT,
              cause: 'VOLUNTARY_LEAVE',
            });
          },
        );

        assert.deepEqual(result, { membershipId: membershipB });
        assert.equal(taskCalls.length, 1);
        assert.equal(supplyCalls.length, 1);
        assert.equal(taskCalls[0]?.tx, supplyCalls[0]?.tx);
        assert.deepEqual(taskCalls[0]?.input, {
          homeId,
          membershipId: membershipB,
          endedAt: ENDED_AT,
          cause: 'VOLUNTARY_LEAVE',
        });
        assert.deepEqual(supplyCalls[0]?.input, taskCalls[0]?.input);

        const after = await database.pool.query<{
          id: string;
          role: string;
          joined_at: Date;
          ended_at: Date | null;
        }>(
          `SELECT id, role, joined_at, ended_at
           FROM memberships
           WHERE id = $1`,
          [membershipB],
        );
        assert.equal(after.rows[0]?.role, 'ROOMMATE');
        assert.equal(after.rows[0]?.joined_at.getTime(), joinedAt.getTime());
        assert.ok(after.rows[0]?.ended_at instanceof Date);
        assert.equal(after.rows[0]?.ended_at?.getTime(), ENDED_AT.getTime());

        const remaining = await database.pool.query<{ ended_at: Date | null }>(
          'SELECT ended_at FROM memberships WHERE id = $1',
          [membershipA],
        );
        assert.equal(remaining.rows[0]?.ended_at, null);

        const events = await database.pool.query<{
          event_id: string;
          event_type: string;
          occurred_at: Date;
          home_id: string;
          payload: { membershipId: string; cause: string };
        }>(
          `SELECT event_id, event_type, occurred_at, home_id, payload
           FROM outbox_events
           WHERE home_id = $1 AND event_type = 'membership.ended.v1'`,
          [homeId],
        );
        assert.equal(events.rows.length, 1);
        assert.equal(typeof events.rows[0]?.event_id, 'string');
        assert.match(
          events.rows[0]?.event_id ?? '',
          /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        assert.equal(events.rows[0]?.home_id, homeId);
        assert.equal(events.rows[0]?.occurred_at.getTime(), ENDED_AT.getTime());
        assert.deepEqual(events.rows[0]?.payload, {
          membershipId: membershipB,
          cause: 'VOLUNTARY_LEAVE',
        });
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
    'rolls back and skips Supply when Task cleanup fails',
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
      const { endMembership, taskCalls, supplyCalls } = createEndingSeam({
        taskError: new Error('injected task cleanup failure'),
      });

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeId, name: 'Task Fail Home' });
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

        await assert.rejects(
          () =>
            runInReadCommittedTransaction(database.pool, async (tx) => {
              await lockHomeStructure(tx, {
                homeId,
                actor: actor({
                  userId: userA,
                  membershipId: membershipA,
                  homeId,
                  role: 'ADMIN',
                }),
              });
              return endMembership(tx, {
                homeId,
                membershipId: membershipB,
                endedAt: ENDED_AT,
                cause: 'VOLUNTARY_LEAVE',
              });
            }),
          /injected task cleanup failure/,
        );

        assert.equal(taskCalls.length, 1);
        assert.equal(supplyCalls.length, 0);

        const membership = await database.pool.query<{
          ended_at: Date | null;
        }>('SELECT ended_at FROM memberships WHERE id = $1', [membershipB]);
        assert.equal(membership.rows[0]?.ended_at, null);

        const events = await database.pool.query<{ event_id: string }>(
          `SELECT event_id FROM outbox_events
           WHERE home_id = $1 AND event_type = 'membership.ended.v1'`,
          [homeId],
        );
        assert.equal(events.rows.length, 0);
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
    'rolls back Task cleanup writes and Membership when Supply cleanup fails',
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
      const { endMembership, taskCalls, supplyCalls } = createEndingSeam({
        writeTaskMarker: true,
        supplyError: new Error('injected supply cleanup failure'),
      });

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, {
          id: homeId,
          name: 'Supply Fail Home',
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

        const beforeHome = await database.pool.query<{ updated_at: Date }>(
          'SELECT updated_at FROM homes WHERE id = $1',
          [homeId],
        );
        const originalUpdatedAt = beforeHome.rows[0]?.updated_at;
        assert.ok(originalUpdatedAt instanceof Date);

        await assert.rejects(
          () =>
            runInReadCommittedTransaction(database.pool, async (tx) => {
              await lockHomeStructure(tx, {
                homeId,
                actor: actor({
                  userId: userA,
                  membershipId: membershipA,
                  homeId,
                  role: 'ADMIN',
                }),
              });
              return endMembership(tx, {
                homeId,
                membershipId: membershipB,
                endedAt: ENDED_AT,
                cause: 'ADMIN_REMOVAL',
              });
            }),
          /injected supply cleanup failure/,
        );

        assert.equal(taskCalls.length, 1);
        assert.equal(supplyCalls.length, 1);

        const membership = await database.pool.query<{
          ended_at: Date | null;
        }>('SELECT ended_at FROM memberships WHERE id = $1', [membershipB]);
        assert.equal(membership.rows[0]?.ended_at, null);

        const home = await database.pool.query<{ updated_at: Date }>(
          'SELECT updated_at FROM homes WHERE id = $1',
          [homeId],
        );
        assert.equal(
          home.rows[0]?.updated_at.getTime(),
          originalUpdatedAt.getTime(),
        );
        assert.notEqual(
          home.rows[0]?.updated_at.getTime(),
          TASK_MARKER_AT.getTime(),
        );

        const events = await database.pool.query<{ event_id: string }>(
          `SELECT event_id FROM outbox_events WHERE home_id = $1`,
          [homeId],
        );
        assert.equal(events.rows.length, 0);
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
    'treats a defensive zero-row UPDATE as integrity failure and rolls back cleanup',
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
      const { endMembership, taskCalls, supplyCalls } = createEndingSeam({
        writeTaskMarker: true,
        updateRows: 0,
      });

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, {
          id: homeId,
          name: 'Zero Row Home',
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

        const beforeHome = await database.pool.query<{ updated_at: Date }>(
          'SELECT updated_at FROM homes WHERE id = $1',
          [homeId],
        );
        const originalUpdatedAt = beforeHome.rows[0]?.updated_at;
        assert.ok(originalUpdatedAt instanceof Date);

        await assert.rejects(
          () =>
            runInReadCommittedTransaction(database.pool, async (tx) => {
              await lockHomeStructure(tx, {
                homeId,
                actor: actor({
                  userId: userA,
                  membershipId: membershipA,
                  homeId,
                  role: 'ADMIN',
                }),
              });
              return endMembership(tx, {
                homeId,
                membershipId: membershipB,
                endedAt: ENDED_AT,
                cause: 'VOLUNTARY_LEAVE',
              });
            }),
          StructuralIntegrityError,
        );

        assert.equal(taskCalls.length, 1);
        assert.equal(supplyCalls.length, 1);

        const membership = await database.pool.query<{
          ended_at: Date | null;
        }>('SELECT ended_at FROM memberships WHERE id = $1', [membershipB]);
        assert.equal(membership.rows[0]?.ended_at, null);

        const home = await database.pool.query<{ updated_at: Date }>(
          'SELECT updated_at FROM homes WHERE id = $1',
          [homeId],
        );
        assert.equal(
          home.rows[0]?.updated_at.getTime(),
          originalUpdatedAt.getTime(),
        );

        const events = await database.pool.query<{ event_id: string }>(
          `SELECT event_id FROM outbox_events WHERE home_id = $1`,
          [homeId],
        );
        assert.equal(events.rows.length, 0);
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
    'rolls back Membership ending and Task cleanup when outbox append fails',
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
      const { endMembership } = createEndingSeam({
        writeTaskMarker: true,
        outboxError: new Error('injected outbox failure'),
      });

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, {
          id: homeId,
          name: 'Outbox Fail Home',
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

        const beforeHome = await database.pool.query<{ updated_at: Date }>(
          'SELECT updated_at FROM homes WHERE id = $1',
          [homeId],
        );
        const originalUpdatedAt = beforeHome.rows[0]?.updated_at;
        assert.ok(originalUpdatedAt instanceof Date);

        await assert.rejects(
          () =>
            runInReadCommittedTransaction(database.pool, async (tx) => {
              await lockHomeStructure(tx, {
                homeId,
                actor: actor({
                  userId: userA,
                  membershipId: membershipA,
                  homeId,
                  role: 'ADMIN',
                }),
              });
              return endMembership(tx, {
                homeId,
                membershipId: membershipB,
                endedAt: ENDED_AT,
                cause: 'VOLUNTARY_LEAVE',
              });
            }),
          /injected outbox failure/,
        );

        const membership = await database.pool.query<{
          ended_at: Date | null;
        }>('SELECT ended_at FROM memberships WHERE id = $1', [membershipB]);
        assert.equal(membership.rows[0]?.ended_at, null);

        const home = await database.pool.query<{ updated_at: Date }>(
          'SELECT updated_at FROM homes WHERE id = $1',
          [homeId],
        );
        assert.equal(
          home.rows[0]?.updated_at.getTime(),
          originalUpdatedAt.getTime(),
        );

        const events = await database.pool.query<{ event_id: string }>(
          `SELECT event_id FROM outbox_events WHERE home_id = $1`,
          [homeId],
        );
        assert.equal(events.rows.length, 0);
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
    'ends only the supplied NEW tenure and refuses to remap an ended OLD tenure',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const membershipOld = randomUUID();
      const membershipNew = randomUUID();
      const oldEndedAt = new Date('2026-02-01T00:00:00.000Z');

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeId, name: 'Rejoin Home' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipOld,
          homeId,
          userId: userB,
          role: 'ROOMMATE',
          endedAt: oldEndedAt,
        });
        await insertMembership(database.pool, {
          id: membershipNew,
          homeId,
          userId: userB,
          role: 'ROOMMATE',
        });

        const { endMembership: endNew } = createEndingSeam();
        await runInReadCommittedTransaction(database.pool, async (tx) => {
          const locked = await lockHomeStructure(tx, {
            homeId,
            actor: actor({
              userId: userA,
              membershipId: membershipA,
              homeId,
              role: 'ADMIN',
            }),
          });
          const target = locked.activeMemberships.find(
            (membership) => membership.id === membershipNew,
          );
          assert.ok(target);
          assert.equal(
            locked.activeMemberships.some(
              (membership) => membership.id === membershipOld,
            ),
            false,
          );
          return endNew(tx, {
            homeId: locked.home.id,
            membershipId: target.id,
            endedAt: ENDED_AT,
            cause: 'VOLUNTARY_LEAVE',
          });
        });

        const rows = await database.pool.query<{
          id: string;
          ended_at: Date | null;
        }>('SELECT id, ended_at FROM memberships WHERE id = ANY($1::uuid[])', [
          [membershipOld, membershipNew],
        ]);
        const byId = new Map(
          rows.rows.map((row) => [row.id, row.ended_at] as const),
        );
        assert.equal(byId.get(membershipOld)?.getTime(), oldEndedAt.getTime());
        assert.equal(byId.get(membershipNew)?.getTime(), ENDED_AT.getTime());

        const endedEvents = await database.pool.query<{
          payload: { membershipId: string };
        }>(
          `SELECT payload FROM outbox_events
           WHERE home_id = $1 AND event_type = 'membership.ended.v1'`,
          [homeId],
        );
        assert.equal(endedEvents.rows.length, 1);
        assert.equal(endedEvents.rows[0]?.payload.membershipId, membershipNew);

        const { endMembership: endOld } = createEndingSeam();
        await assert.rejects(
          () =>
            runInReadCommittedTransaction(database.pool, async (tx) => {
              await lockHomeStructure(tx, {
                homeId,
                actor: actor({
                  userId: userA,
                  membershipId: membershipA,
                  homeId,
                  role: 'ADMIN',
                }),
              });
              return endOld(tx, {
                homeId,
                membershipId: membershipOld,
                endedAt: new Date('2026-04-01T00:00:00.000Z'),
                cause: 'VOLUNTARY_LEAVE',
              });
            }),
          StructuralIntegrityError,
        );

        const oldAfter = await database.pool.query<{ ended_at: Date | null }>(
          'SELECT ended_at FROM memberships WHERE id = $1',
          [membershipOld],
        );
        assert.equal(
          oldAfter.rows[0]?.ended_at?.getTime(),
          oldEndedAt.getTime(),
        );

        const laterEvents = await database.pool.query<{ event_id: string }>(
          `SELECT event_id FROM outbox_events
           WHERE home_id = $1 AND event_type = 'membership.ended.v1'`,
          [homeId],
        );
        assert.equal(laterEvents.rows.length, 1);
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
    'composition Task cleanup issues set-based unassign SQL before Membership UPDATE',
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
      const queries: string[] = [];
      const endMembership = createEndMembershipWithinHomeStructure({
        taskCleanup: createMembershipEndingTaskCleanupFromPool(database.pool),
        supplyCleanup: createMembershipEndingSupplyCleanupFromPool(
          database.pool,
        ),
        membershipEnding: createMembershipEndingWriter(),
        outbox: createOutboxWriter(),
        ids: { next: nextEventId },
      });

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeId, name: 'Noop Home' });
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

        await runInReadCommittedTransaction(database.pool, async (tx) => {
          const wrapped: TransactionContext = {
            query(text, values) {
              queries.push(text);
              return tx.query(text, values);
            },
          };
          await lockHomeStructure(wrapped, {
            homeId,
            actor: actor({
              userId: userA,
              membershipId: membershipA,
              homeId,
              role: 'ADMIN',
            }),
          });
          const beforeCleanup = queries.length;
          await endMembership(wrapped, {
            homeId,
            membershipId: membershipB,
            endedAt: ENDED_AT,
            cause: 'HOME_ARCHIVED',
          });
          const cleanupSql = queries.slice(beforeCleanup);
          assert.equal(cleanupSql.length, 5);
          assert.match(cleanupSql[0] ?? '', /UPDATE task_instances/);
          assert.match(cleanupSql[1] ?? '', /UPDATE task_definitions/);
          assert.match(cleanupSql[2] ?? '', /UPDATE supply_claims/);
          assert.match(cleanupSql[3] ?? '', /UPDATE memberships/);
          assert.match(cleanupSql[4] ?? '', /INSERT INTO outbox_events/);
        });
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
