import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createHomeArchiveWriter } from '../../domains/homes/archive-home.js';
import {
  lockHomeAndExactMemberships,
  tryLockHomeAndExactMemberships,
} from '../../domains/homes/lock-home-and-exact-memberships.js';
import { lockHomeStructure } from '../../domains/homes/lock-home-structure.js';
import { createInvitationHomeArchiveCleanupFromPool } from '../../domains/invitations/home-archive-cleanup.js';
import {
  createTaskRepository,
  type TaskRepository,
} from '../../domains/tasks/repository.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import type { AppConfig } from '../../platform/config/types.js';
import { outboxWriter } from '../../platform/events/outbox-writer.js';
import { createUuidV7, systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import {
  runInReadCommittedTransaction,
  type TransactionContext,
} from '../../platform/persistence/transaction.js';
import { createArchiveFinalMemberHome } from '../home-administration/archive-final-member-home.js';
import { createDeactivateTaskDefinition } from './deactivate-task-definition.js';
import {
  createApplyMembershipEndingWithinHomeStructureFromPool,
  createEndMembershipWithinHomeStructureFromPool,
} from '../home-administration/end-membership-within-home-structure.js';
import { createLeaveMembership } from '../home-administration/leave-membership.js';
import { createProcessDueRecurringTasks } from './process-due-recurring-tasks.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const WORKER_NOW = new Date('2026-09-12T12:00:00.000Z');
const MUTATION_NOW = new Date('2026-09-12T13:00:00.000Z');

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

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function backendPid(tx: TransactionContext): Promise<number> {
  const result = await tx.query<{ pid: number | string }>(
    'SELECT pg_backend_pid() AS pid',
  );
  const pid = result.rows[0]?.pid;
  if (pid === undefined) {
    throw new Error('backend pid was missing');
  }
  return Number(pid);
}

async function waitForLock(pool: Pool, pid: number): Promise<void> {
  const timeout = Date.now() + 8_000;
  while (Date.now() < timeout) {
    const result = await pool.query<{ wait_event_type: string | null }>(
      'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
      [pid],
    );
    if (result.rows[0]?.wait_event_type === 'Lock') {
      return;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new Error('timed out observing PostgreSQL lock wait');
}

type Fixture = Readonly<{
  homeId: string;
  userIds: readonly string[];
  membershipIds: readonly string[];
}>;

async function insertFixture(
  pool: Pool,
  input: { name: string; memberCount?: 1 | 2 },
): Promise<Fixture> {
  const homeId = randomUUID();
  const memberCount = input.memberCount ?? 1;
  const userIds = Array.from({ length: memberCount }, () => randomUUID());
  const membershipIds = Array.from({ length: memberCount }, () => randomUUID());
  for (const userId of userIds) {
    await pool.query('INSERT INTO users (id, updated_at) VALUES ($1, NOW())', [
      userId,
    ]);
  }
  await pool.query(
    `INSERT INTO homes (id, name, timezone, archived_at, updated_at)
     VALUES ($1, $2, 'UTC', NULL, NOW())`,
    [homeId, input.name],
  );
  for (let index = 0; index < memberCount; index += 1) {
    await pool.query(
      `INSERT INTO memberships (id, home_id, user_id, role, ended_at)
       VALUES ($1, $2, $3, $4, NULL)`,
      [
        membershipIds[index],
        homeId,
        userIds[index],
        index === 0 ? 'ADMIN' : 'ROOMMATE',
      ],
    );
  }
  return { homeId, userIds, membershipIds };
}

async function insertDueDefinition(
  pool: Pool,
  fixture: Fixture,
  input: { title: string; assignedMembershipId?: string | null },
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO task_definitions (
       id, home_id, title, assigned_membership_id, creator_membership_id,
       recurrence_frequency, recurrence_weekday, recurrence_day_of_month,
       next_occurrence_date, next_occurrence_at, deactivated_at,
       created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, 'DAILY', NULL, NULL,
       DATE '2026-09-12', TIMESTAMPTZ '2026-09-12T00:00:00Z', NULL,
       TIMESTAMPTZ '2026-01-01T00:00:00Z',
       TIMESTAMPTZ '2026-01-01T00:00:00Z'
     )`,
    [
      id,
      fixture.homeId,
      input.title,
      input.assignedMembershipId ?? null,
      fixture.membershipIds[0],
    ],
  );
  return id;
}

async function cleanup(
  pool: Pool,
  fixtures: readonly Fixture[],
): Promise<void> {
  const homeIds = fixtures.map((fixture) => fixture.homeId);
  const userIds = fixtures.flatMap((fixture) => fixture.userIds);
  if (homeIds.length > 0) {
    await pool.query('DELETE FROM task_instances WHERE home_id = ANY($1)', [
      homeIds,
    ]);
    await pool.query('DELETE FROM task_definitions WHERE home_id = ANY($1)', [
      homeIds,
    ]);
    await pool.query('DELETE FROM invitations WHERE home_id = ANY($1)', [
      homeIds,
    ]);
    await pool.query('DELETE FROM outbox_events WHERE home_id = ANY($1)', [
      homeIds,
    ]);
    await pool.query('DELETE FROM memberships WHERE home_id = ANY($1)', [
      homeIds,
    ]);
    await pool.query('DELETE FROM homes WHERE id = ANY($1)', [homeIds]);
  }
  if (userIds.length > 0) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
  }
}

function actor(fixture: Fixture, membershipIndex = 0): ActiveHomeActor {
  return {
    userId: fixture.userIds[membershipIndex]!,
    membershipId: fixture.membershipIds[membershipIndex]!,
    homeId: fixture.homeId,
    role: membershipIndex === 0 ? 'ADMIN' : 'ROOMMATE',
  };
}

function processCommand(
  pool: Pool,
  options: {
    afterHomeLock?: () => Promise<void>;
    tasks?: TaskRepository;
  } = {},
) {
  const tasks = options.tasks ?? createTaskRepository(pool);
  return createProcessDueRecurringTasks({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    tryLockHomeAndExactMemberships: async (tx, input) => {
      const locked = await tryLockHomeAndExactMemberships(tx, input);
      if (locked !== null && options.afterHomeLock) {
        await options.afterHomeLock();
      }
      return locked;
    },
    tasks,
    clock: { now: () => WORKER_NOW },
    ids: { next: createUuidV7 },
  });
}

function deactivateCommand(
  pool: Pool,
  options: {
    afterHomeLock?: () => Promise<void>;
    capturePid?: (pid: number) => void;
  } = {},
) {
  return createDeactivateTaskDefinition({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeAndExactMemberships: async (tx, input) => {
      if (options.capturePid) {
        options.capturePid(await backendPid(tx));
      }
      const locked = await lockHomeAndExactMemberships(tx, input);
      if (options.afterHomeLock) {
        await options.afterHomeLock();
      }
      return locked;
    },
    tasks: createTaskRepository(pool),
    clock: { now: () => MUTATION_NOW },
  });
}

function leaveCommand(
  pool: Pool,
  afterHomeLock: () => Promise<void>,
  capturePid?: (pid: number) => void,
) {
  return createLeaveMembership({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeStructure: async (tx, input) => {
      if (capturePid) {
        capturePid(await backendPid(tx));
      }
      const locked = await lockHomeStructure(tx, input);
      await afterHomeLock();
      return locked;
    },
    clock: { now: () => MUTATION_NOW },
    endMembership: createEndMembershipWithinHomeStructureFromPool(pool),
  });
}

function archiveCommand(
  pool: Pool,
  afterHomeLock: () => Promise<void>,
  capturePid?: (pid: number) => void,
) {
  return createArchiveFinalMemberHome({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeStructure: async (tx, input) => {
      if (capturePid) {
        capturePid(await backendPid(tx));
      }
      const locked = await lockHomeStructure(tx, input);
      await afterHomeLock();
      return locked;
    },
    clock: { now: () => MUTATION_NOW },
    invitationRevoker: createInvitationHomeArchiveCleanupFromPool(pool),
    applyMembershipEnding:
      createApplyMembershipEndingWithinHomeStructureFromPool(pool),
    homeArchive: createHomeArchiveWriter(),
    outbox: outboxWriter,
    ids: systemUuidV7,
  });
}

async function occurrenceCount(
  pool: Pool,
  definitionId: string,
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM task_instances WHERE task_definition_id = $1`,
    [definitionId],
  );
  return Number(result.rows[0]?.count ?? '-1');
}

void describe('processDueRecurringTasks concurrency PostgreSQL', () => {
  void it(
    'serializes generation and deactivation in both deterministic orders',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixtures: Fixture[] = [];
      try {
        const generationFirst = await insertFixture(database.pool, {
          name: 'Generation before deactivation',
        });
        fixtures.push(generationFirst);
        const firstDefinition = await insertDueDefinition(
          database.pool,
          generationFirst,
          { title: 'Generation wins' },
        );
        const generatedLocked = deferred();
        const generatedMayFinish = deferred();
        const deactivatePid = deferred<number>();
        const generation = processCommand(database.pool, {
          afterHomeLock: async () => {
            generatedLocked.resolve();
            await generatedMayFinish.promise;
          },
        })();
        await generatedLocked.promise;
        const deactivation = deactivateCommand(database.pool, {
          capturePid: (pid) => deactivatePid.resolve(pid),
        })({
          actor: actor(generationFirst),
          homeId: generationFirst.homeId,
          taskDefinitionId: firstDefinition,
        });
        await waitForLock(database.pool, await deactivatePid.promise);
        generatedMayFinish.resolve();
        assert.equal((await generation).occurrencesGenerated, 1);
        await deactivation;
        assert.equal(await occurrenceCount(database.pool, firstDefinition), 1);

        const deactivationFirst = await insertFixture(database.pool, {
          name: 'Deactivation before generation',
        });
        fixtures.push(deactivationFirst);
        const secondDefinition = await insertDueDefinition(
          database.pool,
          deactivationFirst,
          { title: 'Deactivation wins' },
        );
        const deactivateLocked = deferred();
        const deactivateMayFinish = deferred();
        const deactivating = deactivateCommand(database.pool, {
          afterHomeLock: async () => {
            deactivateLocked.resolve();
            await deactivateMayFinish.promise;
          },
        })({
          actor: actor(deactivationFirst),
          homeId: deactivationFirst.homeId,
          taskDefinitionId: secondDefinition,
        });
        await deactivateLocked.promise;
        const skipped = await processCommand(database.pool)();
        assert.deepEqual(skipped, {
          definitionsProcessed: 0,
          occurrencesGenerated: 0,
          occurrencesReconciled: 0,
          moreDueWorkLikely: true,
        });
        deactivateMayFinish.resolve();
        await deactivating;
        assert.equal(await occurrenceCount(database.pool, secondDefinition), 0);
      } finally {
        await cleanup(database.pool, fixtures);
        await database.close();
      }
    },
  );

  void it(
    'cleans generated assignments when archive or Membership ending commits second',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixtures: Fixture[] = [];
      try {
        const archived = await insertFixture(database.pool, {
          name: 'Generation before archive',
        });
        fixtures.push(archived);
        const archivedDefinition = await insertDueDefinition(
          database.pool,
          archived,
          {
            title: 'Generated before archive',
            assignedMembershipId: archived.membershipIds[0],
          },
        );
        const generationLocked = deferred();
        const generationMayFinish = deferred();
        const archivePid = deferred<number>();
        const generation = processCommand(database.pool, {
          afterHomeLock: async () => {
            generationLocked.resolve();
            await generationMayFinish.promise;
          },
        })();
        await generationLocked.promise;
        const archive = archiveCommand(
          database.pool,
          () => Promise.resolve(),
          (pid) => archivePid.resolve(pid),
        )({
          actor: actor(archived),
          homeId: archived.homeId,
        });
        await waitForLock(database.pool, await archivePid.promise);
        generationMayFinish.resolve();
        assert.equal((await generation).occurrencesGenerated, 1);
        await archive;
        const archivedOccurrence = await database.pool.query<{
          assigned_membership_id: string | null;
        }>(
          `SELECT assigned_membership_id FROM task_instances
           WHERE task_definition_id = $1`,
          [archivedDefinition],
        );
        assert.equal(archivedOccurrence.rows[0]?.assigned_membership_id, null);

        const ending = await insertFixture(database.pool, {
          name: 'Generation before ending',
          memberCount: 2,
        });
        fixtures.push(ending);
        const endingDefinition = await insertDueDefinition(
          database.pool,
          ending,
          {
            title: 'Generated before ending',
            assignedMembershipId: ending.membershipIds[1],
          },
        );
        const secondGenerationLocked = deferred();
        const secondGenerationMayFinish = deferred();
        const leavePid = deferred<number>();
        const secondGeneration = processCommand(database.pool, {
          afterHomeLock: async () => {
            secondGenerationLocked.resolve();
            await secondGenerationMayFinish.promise;
          },
        })();
        await secondGenerationLocked.promise;
        const leave = leaveCommand(
          database.pool,
          () => Promise.resolve(),
          (pid) => leavePid.resolve(pid),
        )({
          actor: actor(ending, 1),
          homeId: ending.homeId,
          membershipId: ending.membershipIds[1]!,
        });
        await waitForLock(database.pool, await leavePid.promise);
        secondGenerationMayFinish.resolve();
        assert.equal((await secondGeneration).occurrencesGenerated, 1);
        await leave;
        const endingOccurrence = await database.pool.query<{
          assigned_membership_id: string | null;
        }>(
          `SELECT assigned_membership_id FROM task_instances
           WHERE task_definition_id = $1`,
          [endingDefinition],
        );
        assert.equal(endingOccurrence.rows[0]?.assigned_membership_id, null);
      } finally {
        await cleanup(database.pool, fixtures);
        await database.close();
      }
    },
  );

  void it(
    'skips Home archive and Membership ending locks, then observes their final state',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixtures: Fixture[] = [];
      try {
        const archived = await insertFixture(database.pool, {
          name: 'Archive before generation',
        });
        fixtures.push(archived);
        const archivedDefinition = await insertDueDefinition(
          database.pool,
          archived,
          {
            title: 'Archived definition',
            assignedMembershipId: archived.membershipIds[0],
          },
        );
        const archiveLocked = deferred();
        const archiveMayFinish = deferred();
        const archive = archiveCommand(database.pool, async () => {
          archiveLocked.resolve();
          await archiveMayFinish.promise;
        })({
          actor: actor(archived),
          homeId: archived.homeId,
        });
        await archiveLocked.promise;
        const archiveSkip = await processCommand(database.pool)();
        assert.equal(archiveSkip.definitionsProcessed, 0);
        assert.equal(archiveSkip.moreDueWorkLikely, true);
        archiveMayFinish.resolve();
        await archive;
        assert.equal(
          await occurrenceCount(database.pool, archivedDefinition),
          0,
        );
        const archivedState = await database.pool.query<{
          archived_at: Date | null;
        }>('SELECT archived_at FROM homes WHERE id = $1', [archived.homeId]);
        assert.deepEqual(archivedState.rows[0]?.archived_at, MUTATION_NOW);

        const ending = await insertFixture(database.pool, {
          name: 'Ending before generation',
          memberCount: 2,
        });
        fixtures.push(ending);
        const endingDefinition = await insertDueDefinition(
          database.pool,
          ending,
          {
            title: 'Ending assignee',
            assignedMembershipId: ending.membershipIds[1],
          },
        );
        const endingLocked = deferred();
        const endingMayFinish = deferred();
        const leave = leaveCommand(database.pool, async () => {
          endingLocked.resolve();
          await endingMayFinish.promise;
        })({
          actor: actor(ending, 1),
          homeId: ending.homeId,
          membershipId: ending.membershipIds[1]!,
        });
        await endingLocked.promise;
        const endingSkip = await processCommand(database.pool)();
        assert.equal(endingSkip.definitionsProcessed, 0);
        assert.equal(endingSkip.moreDueWorkLikely, true);
        endingMayFinish.resolve();
        await leave;
        const generated = await processCommand(database.pool)();
        assert.equal(generated.occurrencesGenerated, 1);
        const occurrence = await database.pool.query<{
          assigned_membership_id: string | null;
        }>(
          `SELECT assigned_membership_id FROM task_instances
           WHERE task_definition_id = $1`,
          [endingDefinition],
        );
        assert.equal(occurrence.rows[0]?.assigned_membership_id, null);
      } finally {
        await cleanup(database.pool, fixtures);
        await database.close();
      }
    },
  );

  void it(
    'lets two workers skip a locked Home and make progress on separate definitions',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixtures: Fixture[] = [];
      try {
        const first = await insertFixture(database.pool, {
          name: 'First worker Home',
        });
        const second = await insertFixture(database.pool, {
          name: 'Second worker Home',
        });
        fixtures.push(first, second);
        const firstDefinition = await insertDueDefinition(
          database.pool,
          first,
          {
            title: 'First candidate',
          },
        );
        await database.pool.query(
          `UPDATE task_definitions
           SET next_occurrence_at = TIMESTAMPTZ '2026-09-11T00:00:00Z'
           WHERE id = $1`,
          [firstDefinition],
        );
        const secondDefinition = await insertDueDefinition(
          database.pool,
          second,
          { title: 'Second candidate' },
        );
        const firstLocked = deferred();
        const firstMayFinish = deferred();
        let pauses = 0;
        const firstWorker = processCommand(database.pool, {
          afterHomeLock: async () => {
            pauses += 1;
            if (pauses === 1) {
              firstLocked.resolve();
              await firstMayFinish.promise;
            }
          },
        })({ maxDefinitions: 1 });
        await firstLocked.promise;

        const secondResult = await processCommand(database.pool)({
          maxDefinitions: 1,
        });
        assert.equal(secondResult.definitionsProcessed, 1);
        assert.equal(secondResult.occurrencesGenerated, 1);
        assert.equal(await occurrenceCount(database.pool, firstDefinition), 0);
        assert.equal(await occurrenceCount(database.pool, secondDefinition), 1);

        firstMayFinish.resolve();
        const firstResult = await firstWorker;
        assert.equal(firstResult.definitionsProcessed, 1);
        assert.equal(firstResult.occurrencesGenerated, 1);
        assert.equal(await occurrenceCount(database.pool, firstDefinition), 1);
        assert.equal(await occurrenceCount(database.pool, secondDefinition), 1);
      } finally {
        await cleanup(database.pool, fixtures);
        await database.close();
      }
    },
  );

  void it(
    'never processes the same definition concurrently or duplicates its occurrence',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const fixtures: Fixture[] = [];
      try {
        const fixture = await insertFixture(database.pool, {
          name: 'Same definition workers',
        });
        fixtures.push(fixture);
        const definitionId = await insertDueDefinition(database.pool, fixture, {
          title: 'Single logical occurrence',
        });
        const firstLocked = deferred();
        const firstMayFinish = deferred();
        const firstWorker = processCommand(database.pool, {
          afterHomeLock: async () => {
            firstLocked.resolve();
            await firstMayFinish.promise;
          },
        })({ maxDefinitions: 1 });
        await firstLocked.promise;

        const skipped = await processCommand(database.pool)({
          maxDefinitions: 1,
        });
        assert.deepEqual(skipped, {
          definitionsProcessed: 0,
          occurrencesGenerated: 0,
          occurrencesReconciled: 0,
          moreDueWorkLikely: true,
        });
        assert.equal(await occurrenceCount(database.pool, definitionId), 0);

        firstMayFinish.resolve();
        assert.equal((await firstWorker).occurrencesGenerated, 1);
        const retry = await processCommand(database.pool)();
        assert.equal(retry.occurrencesGenerated, 0);
        assert.equal(retry.occurrencesReconciled, 0);
        assert.equal(await occurrenceCount(database.pool, definitionId), 1);
      } finally {
        await cleanup(database.pool, fixtures);
        await database.close();
      }
    },
  );
});
