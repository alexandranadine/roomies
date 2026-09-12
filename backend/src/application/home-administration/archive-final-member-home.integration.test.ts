import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createHomeArchiveWriter } from '../../domains/homes/archive-home.js';
import { FinalMemberRequiredError } from '../../domains/homes/errors.js';
import { lockHomeStructure } from '../../domains/homes/lock-home-structure.js';
import { StructuralIntegrityError } from '../../domains/homes/structure-errors.js';
import { createActiveHomeActorResolver } from '../../domains/memberships/active-home-actor-resolver.js';
import { LastRoommateRequiresArchiveError } from '../../domains/memberships/errors.js';
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
import {
  createApplyMembershipEndingWithinHomeStructure,
  createEndMembershipWithinHomeStructure,
} from './end-membership-within-home-structure.js';
import {
  createArchiveFinalMemberHome,
  type ArchiveFinalMemberHomeDependencies,
} from './archive-final-member-home.js';
import { createChangeMembershipRole } from './change-membership-role.js';
import { createLeaveMembership } from './leave-membership.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const ARCHIVED_AT = new Date('2026-03-15T12:34:56.789Z');
const LEAVE_AT = new Date('2026-03-16T01:02:03.456Z');
const MARKER_AT = new Date('2026-01-01T00:00:00.000Z');

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

function nextEventId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function actor(input: {
  userId: string;
  membershipId: string;
  homeId: string;
  role?: ActiveHomeActor['role'];
}): ActiveHomeActor {
  return { ...input, role: input.role ?? 'ADMIN' };
}

type Fixture = {
  homeId: string;
  userId: string;
  membershipId: string;
};

async function insertFixture(
  pool: Pool,
  input: {
    name: string;
    timezone?: string;
    role?: 'ROOMMATE' | 'ADMIN';
    secondAdmin?: boolean;
  },
): Promise<Fixture & { userIds: string[] }> {
  const homeId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const userIds = [userId];
  await pool.query('INSERT INTO users (id, updated_at) VALUES ($1, NOW())', [
    userId,
  ]);
  await pool.query(
    `INSERT INTO homes (id, name, timezone, updated_at)
     VALUES ($1, $2, $3, NOW())`,
    [homeId, input.name, input.timezone ?? 'America/Los_Angeles'],
  );
  await pool.query(
    `INSERT INTO memberships (id, home_id, user_id, role, ended_at)
     VALUES ($1, $2, $3, $4, NULL)`,
    [membershipId, homeId, userId, input.role ?? 'ADMIN'],
  );
  if (input.secondAdmin === true) {
    const secondUserId = randomUUID();
    userIds.push(secondUserId);
    await pool.query('INSERT INTO users (id, updated_at) VALUES ($1, NOW())', [
      secondUserId,
    ]);
    await pool.query(
      `INSERT INTO memberships (id, home_id, user_id, role, ended_at)
       VALUES ($1, $2, $3, 'ADMIN', NULL)`,
      [randomUUID(), homeId, secondUserId],
    );
  }
  return { homeId, userId, membershipId, userIds };
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

type CommandOverrides = Partial<
  Pick<
    ArchiveFinalMemberHomeDependencies,
    'invitationRevoker' | 'applyMembershipEnding' | 'homeArchive' | 'outbox'
  >
>;

function createCommand(pool: Pool, overrides: CommandOverrides = {}) {
  return createArchiveFinalMemberHome({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeStructure,
    clock: { now: () => ARCHIVED_AT },
    invitationRevoker: {
      lockPendingForHomeArchive() {
        return Promise.resolve();
      },
      revokeLockedPendingForHomeArchive() {
        return Promise.resolve();
      },
    },
    applyMembershipEnding: createApplyMembershipEndingWithinHomeStructure({
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
    }),
    homeArchive: createHomeArchiveWriter(),
    outbox: createOutboxWriter(),
    ids: { next: nextEventId },
    ...overrides,
  });
}

async function assertPristine(
  pool: Pool,
  fixture: Fixture,
  originalUpdatedAt: Date,
): Promise<void> {
  const home = await pool.query<{
    archived_at: Date | null;
    updated_at: Date;
  }>('SELECT archived_at, updated_at FROM homes WHERE id = $1', [
    fixture.homeId,
  ]);
  assert.equal(home.rows[0]?.archived_at, null);
  assert.equal(home.rows[0]?.updated_at.getTime(), originalUpdatedAt.getTime());
  const membership = await pool.query<{ ended_at: Date | null }>(
    'SELECT ended_at FROM memberships WHERE id = $1',
    [fixture.membershipId],
  );
  assert.equal(membership.rows[0]?.ended_at, null);
  const events = await pool.query<{ event_id: string }>(
    'SELECT event_id FROM outbox_events WHERE home_id = $1',
    [fixture.homeId],
  );
  assert.equal(events.rows.length, 0);
}

void describe('archiveFinalMemberHome PostgreSQL', () => {
  void it(
    'uses only a dedicated safe TEST_DATABASE_URL',
    { skip: skipWithoutDatabase },
    () => {
      const parsed = parseDatabaseUrl(dedicatedTestDatabaseUrl());
      assert.notEqual(parsed.database.toLowerCase(), 'roomies');
      assert.match(parsed.database, /(?:^|_)(?:test|ci)$/i);
    },
  );

  void it(
    'archives a sole DB Admin exactly and preserves Home and Membership history',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const fixture = await insertFixture(database.pool, {
        name: 'Final Member Archive',
        timezone: 'Pacific/Auckland',
      });
      try {
        const beforeHome = await database.pool.query<{
          name: string;
          timezone: string;
          created_at: Date;
          updated_at: Date;
        }>(
          'SELECT name, timezone, created_at, updated_at FROM homes WHERE id = $1',
          [fixture.homeId],
        );
        const beforeMembership = await database.pool.query<{
          home_id: string;
          user_id: string;
          role: string;
          joined_at: Date;
        }>(
          `SELECT home_id, user_id, role, joined_at
           FROM memberships WHERE id = $1`,
          [fixture.membershipId],
        );

        await createCommand(database.pool)({
          homeId: fixture.homeId,
          actor: actor({
            userId: fixture.userId,
            membershipId: fixture.membershipId,
            homeId: fixture.homeId,
            role: 'ROOMMATE',
          }),
        });

        const home = await database.pool.query<{
          name: string;
          timezone: string;
          archived_at: Date;
          created_at: Date;
          updated_at: Date;
        }>(
          `SELECT name, timezone, archived_at, created_at, updated_at
           FROM homes WHERE id = $1`,
          [fixture.homeId],
        );
        assert.equal(
          home.rows[0]?.archived_at.getTime(),
          ARCHIVED_AT.getTime(),
        );
        assert.equal(home.rows[0]?.name, beforeHome.rows[0]?.name);
        assert.equal(home.rows[0]?.timezone, beforeHome.rows[0]?.timezone);
        assert.equal(
          home.rows[0]?.created_at.getTime(),
          beforeHome.rows[0]?.created_at.getTime(),
        );
        assert.equal(
          home.rows[0]?.updated_at.getTime(),
          beforeHome.rows[0]?.updated_at.getTime(),
        );

        const membership = await database.pool.query<{
          home_id: string;
          user_id: string;
          role: string;
          joined_at: Date;
          ended_at: Date;
        }>(
          `SELECT home_id, user_id, role, joined_at, ended_at
           FROM memberships WHERE id = $1`,
          [fixture.membershipId],
        );
        assert.deepEqual(
          {
            home_id: membership.rows[0]?.home_id,
            user_id: membership.rows[0]?.user_id,
            role: membership.rows[0]?.role,
            joined_at: membership.rows[0]?.joined_at.getTime(),
          },
          {
            home_id: beforeMembership.rows[0]?.home_id,
            user_id: beforeMembership.rows[0]?.user_id,
            role: beforeMembership.rows[0]?.role,
            joined_at: beforeMembership.rows[0]?.joined_at.getTime(),
          },
        );
        assert.equal(
          membership.rows[0]?.ended_at.getTime(),
          ARCHIVED_AT.getTime(),
        );

        const events = await database.pool.query<{
          event_type: string;
          occurred_at: Date;
          payload: Record<string, string>;
        }>(
          `SELECT event_type, occurred_at, payload
           FROM outbox_events WHERE home_id = $1 ORDER BY event_type`,
          [fixture.homeId],
        );
        assert.deepEqual(
          events.rows.map((row) => ({
            eventType: row.event_type,
            occurredAt: row.occurred_at.getTime(),
            payload: row.payload,
          })),
          [
            {
              eventType: 'home.archived.v1',
              occurredAt: ARCHIVED_AT.getTime(),
              payload: { homeId: fixture.homeId },
            },
            {
              eventType: 'membership.ended.v1',
              occurredAt: ARCHIVED_AT.getTime(),
              payload: {
                membershipId: fixture.membershipId,
                cause: 'HOME_ARCHIVED',
              },
            },
          ],
        );
        assert.equal(
          await createActiveHomeActorResolver(database.pool).resolve({
            userId: fixture.userId,
            homeId: fixture.homeId,
          }),
          null,
        );
      } finally {
        await cleanup(database.pool, {
          homeIds: [fixture.homeId],
          userIds: fixture.userIds,
        });
        await database.close();
      }
    },
  );

  void it(
    'rejects a Home with more than one active Admin without mutation',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const fixture = await insertFixture(database.pool, {
        name: 'Two Admin Conflict',
        secondAdmin: true,
      });
      try {
        const before = await database.pool.query<{ updated_at: Date }>(
          'SELECT updated_at FROM homes WHERE id = $1',
          [fixture.homeId],
        );
        await assert.rejects(
          () =>
            createCommand(database.pool)({
              homeId: fixture.homeId,
              actor: actor({
                userId: fixture.userId,
                membershipId: fixture.membershipId,
                homeId: fixture.homeId,
              }),
            }),
          FinalMemberRequiredError,
        );
        await assertPristine(
          database.pool,
          fixture,
          before.rows[0]!.updated_at,
        );
      } finally {
        await cleanup(database.pool, {
          homeIds: [fixture.homeId],
          userIds: fixture.userIds,
        });
        await database.close();
      }
    },
  );

  void it(
    'evaluates after a concurrent safe actor demotion and returns FORBIDDEN',
    { skip: skipWithoutDatabase, timeout: 20_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const fixture = await insertFixture(database.pool, {
        name: 'Archive Versus Role Change',
        secondAdmin: true,
      });
      let releaseWriter!: () => void;
      const writerMayContinue = new Promise<void>((resolve) => {
        releaseWriter = resolve;
      });
      let writerReached!: () => void;
      const writerWasReached = new Promise<void>((resolve) => {
        writerReached = resolve;
      });
      const innerWriter = createMembershipRoleWriter();
      const changeRole = createChangeMembershipRole({
        runTransaction: (work) =>
          runInReadCommittedTransaction(database.pool, work),
        lockHomeStructure,
        outbox: createOutboxWriter(),
        clock: { now: () => ARCHIVED_AT },
        ids: { next: nextEventId },
        roleWriter: {
          async updateActiveRole(tx, input) {
            writerReached();
            await writerMayContinue;
            return innerWriter.updateActiveRole(tx, input);
          },
        },
      });
      const currentActor = actor({
        userId: fixture.userId,
        membershipId: fixture.membershipId,
        homeId: fixture.homeId,
      });

      try {
        const demotion = changeRole({
          homeId: fixture.homeId,
          membershipId: fixture.membershipId,
          role: 'ROOMMATE',
          actor: currentActor,
        });
        await writerWasReached;
        const archive = createCommand(database.pool)({
          homeId: fixture.homeId,
          actor: currentActor,
        });
        releaseWriter();

        await demotion;
        await assert.rejects(() => archive, ForbiddenError);

        const state = await database.pool.query<{
          archived_at: Date | null;
          role: string;
          ended_at: Date | null;
        }>(
          `SELECT h.archived_at, m.role, m.ended_at
           FROM homes h
           JOIN memberships m ON m.home_id = h.id
           WHERE h.id = $1 AND m.id = $2`,
          [fixture.homeId, fixture.membershipId],
        );
        assert.equal(state.rows[0]?.archived_at, null);
        assert.equal(state.rows[0]?.role, 'ROOMMATE');
        assert.equal(state.rows[0]?.ended_at, null);
        const archiveEvents = await database.pool.query<{ event_type: string }>(
          `SELECT event_type FROM outbox_events
           WHERE home_id = $1
             AND event_type IN ('membership.ended.v1', 'home.archived.v1')`,
          [fixture.homeId],
        );
        assert.equal(archiveEvents.rows.length, 0);
      } finally {
        releaseWriter();
        await cleanup(database.pool, {
          homeIds: [fixture.homeId],
          userIds: fixture.userIds,
        });
        await database.close();
      }
    },
  );

  void it(
    'serializes double archive to one success, one concealed 404, and one event pair',
    { skip: skipWithoutDatabase, timeout: 20_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const fixture = await insertFixture(database.pool, {
        name: 'Concurrent Archive',
      });
      try {
        const input = {
          homeId: fixture.homeId,
          actor: actor({
            userId: fixture.userId,
            membershipId: fixture.membershipId,
            homeId: fixture.homeId,
          }),
        };
        const results = await Promise.allSettled([
          createCommand(database.pool)(input),
          createCommand(database.pool)(input),
        ]);
        assert.equal(
          results.filter((result) => result.status === 'fulfilled').length,
          1,
        );
        const rejected = results.filter(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected',
        );
        assert.equal(rejected.length, 1);
        assert.ok(rejected[0]?.reason instanceof ConcealedNotFoundError);
        const events = await database.pool.query<{ event_type: string }>(
          `SELECT event_type FROM outbox_events
           WHERE home_id = $1 ORDER BY event_type`,
          [fixture.homeId],
        );
        assert.deepEqual(
          events.rows.map((row) => row.event_type),
          ['home.archived.v1', 'membership.ended.v1'],
        );
      } finally {
        await cleanup(database.pool, {
          homeIds: [fixture.homeId],
          userIds: fixture.userIds,
        });
        await database.close();
      }
    },
  );

  void it(
    'serializes archive against sole-member leave to a valid archived result',
    { skip: skipWithoutDatabase, timeout: 20_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const fixture = await insertFixture(database.pool, {
        name: 'Archive Versus Leave',
      });
      try {
        const activeActor = actor({
          userId: fixture.userId,
          membershipId: fixture.membershipId,
          homeId: fixture.homeId,
        });
        const leave = createLeaveMembership({
          runTransaction: (work) =>
            runInReadCommittedTransaction(database.pool, work),
          lockHomeStructure,
          clock: { now: () => LEAVE_AT },
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
        });
        const results = await Promise.allSettled([
          createCommand(database.pool)({
            homeId: fixture.homeId,
            actor: activeActor,
          }),
          leave({
            homeId: fixture.homeId,
            membershipId: fixture.membershipId,
            actor: activeActor,
          }),
        ]);
        assert.equal(results[0]?.status, 'fulfilled');
        assert.equal(results[1]?.status, 'rejected');
        assert.ok(
          results[1]?.status === 'rejected' &&
            (results[1].reason instanceof ConcealedNotFoundError ||
              results[1].reason instanceof LastRoommateRequiresArchiveError),
        );
        const home = await database.pool.query<{ archived_at: Date }>(
          'SELECT archived_at FROM homes WHERE id = $1',
          [fixture.homeId],
        );
        assert.equal(
          home.rows[0]?.archived_at.getTime(),
          ARCHIVED_AT.getTime(),
        );
        const events = await database.pool.query<{ event_type: string }>(
          'SELECT event_type FROM outbox_events WHERE home_id = $1',
          [fixture.homeId],
        );
        assert.deepEqual(
          new Set(events.rows.map((row) => row.event_type)),
          new Set(['membership.ended.v1', 'home.archived.v1']),
        );
        assert.equal(events.rows.length, 2);
      } finally {
        await cleanup(database.pool, {
          homeIds: [fixture.homeId],
          userIds: fixture.userIds,
        });
        await database.close();
      }
    },
  );

  void it(
    'rolls back every invitation, cleanup, writer, and outbox failure seam',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const allHomeIds: string[] = [];
      const allUserIds: string[] = [];
      const membershipWriter = createMembershipEndingWriter();
      const outboxWriter = createOutboxWriter();

      type FailureCase = {
        name: string;
        overrides: (fixture: Fixture) => CommandOverrides;
        expected: RegExp | (new (...args: never[]) => Error);
      };
      const cases: FailureCase[] = [
        {
          name: 'invitation lock',
          expected: /injected invitation lock failure/,
          overrides: () => ({
            invitationRevoker: {
              lockPendingForHomeArchive() {
                return Promise.reject(
                  new Error('injected invitation lock failure'),
                );
              },
              revokeLockedPendingForHomeArchive() {
                return Promise.resolve();
              },
            },
          }),
        },
        {
          name: 'invitation revoke',
          expected: /injected invitation failure/,
          overrides: () => ({
            invitationRevoker: {
              async lockPendingForHomeArchive(tx, input) {
                await tx.query(
                  'UPDATE homes SET updated_at = $1 WHERE id = $2',
                  [MARKER_AT, input.homeId],
                );
              },
              revokeLockedPendingForHomeArchive() {
                return Promise.reject(new Error('injected invitation failure'));
              },
            },
          }),
        },
        {
          name: 'Task',
          expected: /injected Task failure/,
          overrides: () => ({
            applyMembershipEnding:
              createApplyMembershipEndingWithinHomeStructure({
                taskCleanup: {
                  handleMembershipEnded() {
                    return Promise.reject(new Error('injected Task failure'));
                  },
                },
                supplyCleanup: {
                  handleMembershipEnded() {
                    return Promise.resolve();
                  },
                },
                membershipEnding: membershipWriter,
              }),
          }),
        },
        {
          name: 'Supply',
          expected: /injected Supply failure/,
          overrides: () => ({
            applyMembershipEnding:
              createApplyMembershipEndingWithinHomeStructure({
                taskCleanup: {
                  async handleMembershipEnded(tx, input) {
                    await tx.query(
                      'UPDATE homes SET updated_at = $1 WHERE id = $2',
                      [MARKER_AT, input.homeId],
                    );
                  },
                },
                supplyCleanup: {
                  handleMembershipEnded() {
                    return Promise.reject(new Error('injected Supply failure'));
                  },
                },
                membershipEnding: membershipWriter,
              }),
          }),
        },
        ...(['zero', 'failure'] as const).map((mode): FailureCase => ({
          name: `Membership writer ${mode}`,
          expected:
            mode === 'zero'
              ? StructuralIntegrityError
              : /injected Membership writer failure/,
          overrides: () => ({
            applyMembershipEnding:
              createApplyMembershipEndingWithinHomeStructure({
                taskCleanup: {
                  async handleMembershipEnded(tx, input) {
                    await tx.query(
                      'UPDATE homes SET updated_at = $1 WHERE id = $2',
                      [MARKER_AT, input.homeId],
                    );
                  },
                },
                supplyCleanup: {
                  handleMembershipEnded() {
                    return Promise.resolve();
                  },
                },
                membershipEnding: {
                  endActiveMembership() {
                    if (mode === 'failure') {
                      return Promise.reject(
                        new Error('injected Membership writer failure'),
                      );
                    }
                    return Promise.resolve(0);
                  },
                },
              }),
          }),
        })),
        ...(['zero', 'failure'] as const).map((mode): FailureCase => ({
          name: `Home writer ${mode}`,
          expected:
            mode === 'zero'
              ? StructuralIntegrityError
              : /injected Home writer failure/,
          overrides: () => ({
            homeArchive: {
              archiveActiveHome() {
                if (mode === 'failure') {
                  return Promise.reject(
                    new Error('injected Home writer failure'),
                  );
                }
                return Promise.resolve(0);
              },
            },
          }),
        })),
        ...([1, 2] as const).map((failedAppend): FailureCase => ({
          name: `${failedAppend === 1 ? 'first' : 'second'} outbox`,
          expected: new RegExp(`injected outbox ${failedAppend} failure`),
          overrides: () => {
            let calls = 0;
            return {
              outbox: {
                append(tx, event) {
                  calls += 1;
                  if (calls === failedAppend) {
                    return Promise.reject(
                      new Error(`injected outbox ${failedAppend} failure`),
                    );
                  }
                  return outboxWriter.append(tx, event);
                },
              },
            };
          },
        })),
      ];

      try {
        for (const failureCase of cases) {
          const fixture = await insertFixture(database.pool, {
            name: `Rollback ${failureCase.name}`,
          });
          allHomeIds.push(fixture.homeId);
          allUserIds.push(...fixture.userIds);
          const before = await database.pool.query<{ updated_at: Date }>(
            'SELECT updated_at FROM homes WHERE id = $1',
            [fixture.homeId],
          );
          const originalUpdatedAt = before.rows[0]!.updated_at;
          await assert.rejects(
            () =>
              createCommand(
                database.pool,
                failureCase.overrides(fixture),
              )({
                homeId: fixture.homeId,
                actor: actor({
                  userId: fixture.userId,
                  membershipId: fixture.membershipId,
                  homeId: fixture.homeId,
                }),
              }),
            failureCase.expected,
            failureCase.name,
          );
          await assertPristine(database.pool, fixture, originalUpdatedAt);
        }
      } finally {
        await cleanup(database.pool, {
          homeIds: allHomeIds,
          userIds: allUserIds,
        });
        await database.close();
      }
    },
  );
});
