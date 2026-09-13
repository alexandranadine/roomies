import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createArchiveFinalMemberHome } from '../home-administration/archive-final-member-home.js';
import {
  createApplyMembershipEndingWithinHomeStructureFromPool,
  createEndMembershipWithinHomeStructure,
} from '../home-administration/end-membership-within-home-structure.js';
import { createLeaveMembership } from '../home-administration/leave-membership.js';
import { createRemoveMembership } from '../home-administration/remove-membership.js';
import { createHomeArchiveWriter } from '../../domains/homes/archive-home.js';
import { lockHomeStructure } from '../../domains/homes/lock-home-structure.js';
import { createMembershipEndingWriter } from '../../domains/memberships/update-active-membership-ended-at.js';
import {
  createSupplyRepository,
  type NewSupplyClaim,
  type NewSupplyEntry,
  type SupplyRepository,
} from '../../domains/supplies/repository.js';
import type { SupplyClaimReleaseReason } from '../../domains/supplies/supply.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import type { AppConfig } from '../../platform/config/types.js';
import { createOutboxWriter } from '../../platform/events/outbox-writer.js';
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import { createMembershipEndingSupplyCleanupFromPool } from './membership-ending-supply-cleanup.js';
import { createMembershipEndingTaskCleanupFromPool } from '../tasks/membership-ending-task-cleanup.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const ENDED_AT = new Date('2026-03-15T12:34:56.789Z');
const ARCHIVE_AT = new Date('2026-03-15T12:34:56.789Z');
const CLAIMED_AT = new Date('2026-03-01T08:00:00.000Z');
const PREVIOUSLY_RELEASED_AT = new Date('2026-03-10T00:00:00.000Z');
const CREATED_AT = new Date('2026-03-01T08:00:00.000Z');

function testConfig(databaseUrl: string): AppConfig {
  return {
    appEnv: 'test',
    port: 3000,
    databaseUrl,
    authSecret: 'roomies_test_secret_32_chars_minimum_value',
    authBaseUrl: 'http://localhost:3000',
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

function nextEventId(): string {
  return createUuidV7();
}

async function insertUser(pool: Pool, id: string): Promise<void> {
  await pool.query('INSERT INTO users (id, updated_at) VALUES ($1, NOW())', [
    id,
  ]);
}

async function insertHome(pool: Pool, id: string, name: string): Promise<void> {
  await pool.query(
    `INSERT INTO homes (id, name, timezone, archived_at, updated_at)
     VALUES ($1, $2, 'UTC', NULL, NOW())`,
    [id, name],
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

async function insertEntry(
  supplies: SupplyRepository,
  pool: Pool,
  entry: NewSupplyEntry,
): Promise<void> {
  await runInReadCommittedTransaction(pool, async (tx) => {
    await supplies.insertSupplyEntry(tx, entry);
  });
}

async function insertClaim(
  supplies: SupplyRepository,
  pool: Pool,
  claim: NewSupplyClaim,
): Promise<void> {
  await runInReadCommittedTransaction(pool, async (tx) => {
    await supplies.insertSupplyClaim(tx, claim);
  });
}

function openEntry(input: {
  id: string;
  homeId: string;
  createdByMembershipId: string;
  title?: string;
}): NewSupplyEntry {
  return {
    id: input.id,
    homeId: input.homeId,
    title: input.title ?? 'Paper towels',
    status: 'OPEN',
    createdByMembershipId: input.createdByMembershipId,
    obtainedAt: null,
    canceledAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function activeClaim(input: {
  id: string;
  homeId: string;
  supplyEntryId: string;
  claimantMembershipId: string;
}): NewSupplyClaim {
  return {
    id: input.id,
    homeId: input.homeId,
    supplyEntryId: input.supplyEntryId,
    claimantMembershipId: input.claimantMembershipId,
    claimedAt: CLAIMED_AT,
    releasedAt: null,
    releaseReason: null,
    createdAt: CLAIMED_AT,
    updatedAt: CLAIMED_AT,
  };
}

function releasedClaim(input: {
  id: string;
  homeId: string;
  supplyEntryId: string;
  claimantMembershipId: string;
  releaseReason: SupplyClaimReleaseReason;
}): NewSupplyClaim {
  return {
    id: input.id,
    homeId: input.homeId,
    supplyEntryId: input.supplyEntryId,
    claimantMembershipId: input.claimantMembershipId,
    claimedAt: CLAIMED_AT,
    releasedAt: PREVIOUSLY_RELEASED_AT,
    releaseReason: input.releaseReason,
    createdAt: CLAIMED_AT,
    updatedAt: PREVIOUSLY_RELEASED_AT,
  };
}

async function cleanup(
  pool: Pool,
  input: { homeIds: string[]; userIds: string[] },
): Promise<void> {
  if (input.homeIds.length > 0) {
    await pool.query('DELETE FROM supply_claims WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query('DELETE FROM supply_entries WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query('DELETE FROM task_instances WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query('DELETE FROM task_definitions WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query('DELETE FROM invitations WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
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

function leaveCommand(pool: Pool) {
  return createLeaveMembership({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeStructure,
    clock: { now: () => ENDED_AT },
    endMembership: createEndMembershipWithinHomeStructure({
      taskCleanup: createMembershipEndingTaskCleanupFromPool(pool),
      supplyCleanup: createMembershipEndingSupplyCleanupFromPool(pool),
      membershipEnding: createMembershipEndingWriter(),
      outbox: createOutboxWriter(),
      ids: { next: nextEventId },
    }),
  });
}

function removeCommand(pool: Pool) {
  return createRemoveMembership({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeStructure,
    clock: { now: () => ENDED_AT },
    endMembership: createEndMembershipWithinHomeStructure({
      taskCleanup: createMembershipEndingTaskCleanupFromPool(pool),
      supplyCleanup: createMembershipEndingSupplyCleanupFromPool(pool),
      membershipEnding: createMembershipEndingWriter(),
      outbox: createOutboxWriter(),
      ids: { next: nextEventId },
    }),
  });
}

type ClaimState = {
  claimantMembershipId: string;
  releasedAt: Date | null;
  releaseReason: string | null;
  updatedAt: Date;
  claimedAt: Date;
  createdAt: Date;
  homeId: string;
  supplyEntryId: string;
};

async function claimState(pool: Pool, claimId: string): Promise<ClaimState> {
  const result = await pool.query<{
    claimant_membership_id: string;
    released_at: Date | null;
    release_reason: string | null;
    updated_at: Date;
    claimed_at: Date;
    created_at: Date;
    home_id: string;
    supply_entry_id: string;
  }>(
    `SELECT claimant_membership_id, released_at, release_reason, updated_at,
            claimed_at, created_at, home_id, supply_entry_id
     FROM supply_claims WHERE id = $1`,
    [claimId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`claim ${claimId} was missing`);
  }
  return {
    claimantMembershipId: row.claimant_membership_id,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
    updatedAt: row.updated_at,
    claimedAt: row.claimed_at,
    createdAt: row.created_at,
    homeId: row.home_id,
    supplyEntryId: row.supply_entry_id,
  };
}

async function entryState(
  pool: Pool,
  entryId: string,
): Promise<{
  status: string;
  updatedAt: Date;
  obtainedAt: Date | null;
  canceledAt: Date | null;
  createdByMembershipId: string;
  title: string;
}> {
  const result = await pool.query<{
    status: string;
    updated_at: Date;
    obtained_at: Date | null;
    canceled_at: Date | null;
    created_by_membership_id: string;
    title: string;
  }>(
    `SELECT status, updated_at, obtained_at, canceled_at,
            created_by_membership_id, title
     FROM supply_entries WHERE id = $1`,
    [entryId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`entry ${entryId} was missing`);
  }
  return {
    status: row.status,
    updatedAt: row.updated_at,
    obtainedAt: row.obtained_at,
    canceledAt: row.canceled_at,
    createdByMembershipId: row.created_by_membership_id,
    title: row.title,
  };
}

async function membershipEndedAt(
  pool: Pool,
  membershipId: string,
): Promise<Date | null> {
  const result = await pool.query<{ ended_at: Date | null }>(
    'SELECT ended_at FROM memberships WHERE id = $1',
    [membershipId],
  );
  return result.rows[0]?.ended_at ?? null;
}

async function outboxTypes(pool: Pool, homeId: string): Promise<string[]> {
  const result = await pool.query<{ event_type: string }>(
    `SELECT event_type FROM outbox_events WHERE home_id = $1 ORDER BY event_type`,
    [homeId],
  );
  return result.rows.map((row) => row.event_type);
}

void describe('Membership-ending Supply cleanup PostgreSQL', () => {
  void it(
    'treats zero matching Supply claims as success and still ends the Membership',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const supplies = createSupplyRepository(database.pool);
      const adminUser = randomUUID();
      const leavingUser = randomUUID();
      const homeId = randomUUID();
      const adminMembership = randomUUID();
      const leavingMembership = randomUUID();

      try {
        await insertUser(database.pool, adminUser);
        await insertUser(database.pool, leavingUser);
        await insertHome(database.pool, homeId, 'Empty supply cleanup');
        await insertMembership(database.pool, {
          id: adminMembership,
          homeId,
          userId: adminUser,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: leavingMembership,
          homeId,
          userId: leavingUser,
          role: 'ROOMMATE',
        });

        await leaveCommand(database.pool)({
          homeId,
          membershipId: leavingMembership,
          actor: actor({
            userId: leavingUser,
            membershipId: leavingMembership,
            homeId,
            role: 'ROOMMATE',
          }),
        });

        assert.deepEqual(
          await membershipEndedAt(database.pool, leavingMembership),
          ENDED_AT,
        );
        assert.deepEqual(await outboxTypes(database.pool, homeId), [
          'membership.ended.v1',
        ]);
        assert.deepEqual(await supplies.listOpenEntriesByHome(homeId), []);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [adminUser, leavingUser],
        });
        await database.close();
      }
    },
  );

  void it(
    'releases one active claim with MEMBERSHIP_ENDED and the shared endedAt',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const supplies = createSupplyRepository(database.pool);
      const adminUser = randomUUID();
      const leavingUser = randomUUID();
      const homeId = randomUUID();
      const adminMembership = randomUUID();
      const leavingMembership = randomUUID();
      const entryId = createUuidV7();
      const claimId = createUuidV7();

      try {
        await insertUser(database.pool, adminUser);
        await insertUser(database.pool, leavingUser);
        await insertHome(database.pool, homeId, 'One claim');
        await insertMembership(database.pool, {
          id: adminMembership,
          homeId,
          userId: adminUser,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: leavingMembership,
          homeId,
          userId: leavingUser,
          role: 'ROOMMATE',
        });
        await insertEntry(
          supplies,
          database.pool,
          openEntry({
            id: entryId,
            homeId,
            createdByMembershipId: adminMembership,
          }),
        );
        await insertClaim(
          supplies,
          database.pool,
          activeClaim({
            id: claimId,
            homeId,
            supplyEntryId: entryId,
            claimantMembershipId: leavingMembership,
          }),
        );

        await leaveCommand(database.pool)({
          homeId,
          membershipId: leavingMembership,
          actor: actor({
            userId: leavingUser,
            membershipId: leavingMembership,
            homeId,
            role: 'ROOMMATE',
          }),
        });

        const released = await claimState(database.pool, claimId);
        const entry = await entryState(database.pool, entryId);
        const endedAt = await membershipEndedAt(
          database.pool,
          leavingMembership,
        );
        assert.deepEqual(released.releasedAt, ENDED_AT);
        assert.equal(released.releaseReason, 'MEMBERSHIP_ENDED');
        assert.deepEqual(released.updatedAt, ENDED_AT);
        assert.deepEqual(released.releasedAt, endedAt);
        assert.deepEqual(released.updatedAt, endedAt);
        assert.equal(released.claimantMembershipId, leavingMembership);
        assert.deepEqual(released.claimedAt, CLAIMED_AT);
        assert.deepEqual(released.createdAt, CLAIMED_AT);
        assert.equal(entry.status, 'OPEN');
        assert.deepEqual(entry.updatedAt, CREATED_AT);
        assert.equal(entry.obtainedAt, null);
        assert.equal(entry.canceledAt, null);
        assert.equal(entry.createdByMembershipId, adminMembership);
        assert.equal(
          await supplies.findActiveClaimByEntry(homeId, entryId),
          null,
        );
        assert.deepEqual(await outboxTypes(database.pool, homeId), [
          'membership.ended.v1',
        ]);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [adminUser, leavingUser],
        });
        await database.close();
      }
    },
  );

  void it(
    'releases every active claim for the ending Membership with one timestamp',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const supplies = createSupplyRepository(database.pool);
      const adminUser = randomUUID();
      const leavingUser = randomUUID();
      const homeId = randomUUID();
      const adminMembership = randomUUID();
      const leavingMembership = randomUUID();
      const entryIds = [createUuidV7(), createUuidV7(), createUuidV7()];
      const claimIds = [createUuidV7(), createUuidV7(), createUuidV7()];

      try {
        await insertUser(database.pool, adminUser);
        await insertUser(database.pool, leavingUser);
        await insertHome(database.pool, homeId, 'Many claims');
        await insertMembership(database.pool, {
          id: adminMembership,
          homeId,
          userId: adminUser,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: leavingMembership,
          homeId,
          userId: leavingUser,
          role: 'ROOMMATE',
        });
        for (const [index, entryId] of entryIds.entries()) {
          await insertEntry(
            supplies,
            database.pool,
            openEntry({
              id: entryId,
              homeId,
              createdByMembershipId: adminMembership,
              title: `Item ${index}`,
            }),
          );
          const claimId = claimIds[index];
          if (claimId === undefined) {
            throw new Error('claim id missing');
          }
          await insertClaim(
            supplies,
            database.pool,
            activeClaim({
              id: claimId,
              homeId,
              supplyEntryId: entryId,
              claimantMembershipId: leavingMembership,
            }),
          );
        }

        await leaveCommand(database.pool)({
          homeId,
          membershipId: leavingMembership,
          actor: actor({
            userId: leavingUser,
            membershipId: leavingMembership,
            homeId,
            role: 'ROOMMATE',
          }),
        });

        const released = await Promise.all(
          claimIds.map((id) => claimState(database.pool, id)),
        );
        for (const row of released) {
          assert.deepEqual(row.releasedAt, ENDED_AT);
          assert.equal(row.releaseReason, 'MEMBERSHIP_ENDED');
          assert.deepEqual(row.updatedAt, ENDED_AT);
          assert.equal(row.claimantMembershipId, leavingMembership);
        }
        for (const entryId of entryIds) {
          assert.equal(
            (await entryState(database.pool, entryId)).status,
            'OPEN',
          );
          assert.equal(
            await supplies.findActiveClaimByEntry(homeId, entryId),
            null,
          );
        }
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [adminUser, leavingUser],
        });
        await database.close();
      }
    },
  );

  void it(
    'leaves previously released claims byte-equivalent and only changes the active mix',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const supplies = createSupplyRepository(database.pool);
      const adminUser = randomUUID();
      const leavingUser = randomUUID();
      const homeId = randomUUID();
      const adminMembership = randomUUID();
      const leavingMembership = randomUUID();
      const reasons = [
        'CLAIMANT_RELEASED',
        'ENTRY_OBTAINED',
        'ENTRY_CANCELED',
        'MEMBERSHIP_ENDED',
      ] as const;
      const historical = reasons.map((releaseReason) => ({
        entryId: createUuidV7(),
        claimId: createUuidV7(),
        releaseReason,
      }));
      const activeEntry = createUuidV7();
      const activeClaimId = createUuidV7();

      try {
        await insertUser(database.pool, adminUser);
        await insertUser(database.pool, leavingUser);
        await insertHome(database.pool, homeId, 'Mixed history');
        await insertMembership(database.pool, {
          id: adminMembership,
          homeId,
          userId: adminUser,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: leavingMembership,
          homeId,
          userId: leavingUser,
          role: 'ROOMMATE',
        });
        for (const row of historical) {
          await insertEntry(
            supplies,
            database.pool,
            openEntry({
              id: row.entryId,
              homeId,
              createdByMembershipId: adminMembership,
              title: row.releaseReason,
            }),
          );
          await insertClaim(
            supplies,
            database.pool,
            releasedClaim({
              id: row.claimId,
              homeId,
              supplyEntryId: row.entryId,
              claimantMembershipId: leavingMembership,
              releaseReason: row.releaseReason,
            }),
          );
        }
        await insertEntry(
          supplies,
          database.pool,
          openEntry({
            id: activeEntry,
            homeId,
            createdByMembershipId: adminMembership,
            title: 'Still claimed',
          }),
        );
        await insertClaim(
          supplies,
          database.pool,
          activeClaim({
            id: activeClaimId,
            homeId,
            supplyEntryId: activeEntry,
            claimantMembershipId: leavingMembership,
          }),
        );

        const before = await Promise.all(
          historical.map((row) => claimState(database.pool, row.claimId)),
        );

        await leaveCommand(database.pool)({
          homeId,
          membershipId: leavingMembership,
          actor: actor({
            userId: leavingUser,
            membershipId: leavingMembership,
            homeId,
            role: 'ROOMMATE',
          }),
        });

        const after = await Promise.all(
          historical.map((row) => claimState(database.pool, row.claimId)),
        );
        assert.deepEqual(after, before);
        const released = await claimState(database.pool, activeClaimId);
        assert.deepEqual(released.releasedAt, ENDED_AT);
        assert.equal(released.releaseReason, 'MEMBERSHIP_ENDED');
        assert.deepEqual(released.updatedAt, ENDED_AT);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [adminUser, leavingUser],
        });
        await database.close();
      }
    },
  );

  void it(
    'scopes cleanup to exact Home and Membership and leaves a cross-Home claim untouched',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const supplies = createSupplyRepository(database.pool);
      const adminUser = randomUUID();
      const leavingUser = randomUUID();
      const otherUser = randomUUID();
      const homeId = randomUUID();
      const otherHome = randomUUID();
      const adminMembership = randomUUID();
      const leavingMembership = randomUUID();
      const otherMembership = randomUUID();
      const stayingMembership = randomUUID();
      const leavingEntry = createUuidV7();
      const stayingEntry = createUuidV7();
      const otherEntry = createUuidV7();
      const leavingClaim = createUuidV7();
      const stayingClaim = createUuidV7();
      const otherClaim = createUuidV7();

      try {
        await insertUser(database.pool, adminUser);
        await insertUser(database.pool, leavingUser);
        await insertUser(database.pool, otherUser);
        await insertHome(database.pool, homeId, 'Scoped home');
        await insertHome(database.pool, otherHome, 'Other home');
        await insertMembership(database.pool, {
          id: adminMembership,
          homeId,
          userId: adminUser,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: leavingMembership,
          homeId,
          userId: leavingUser,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: stayingMembership,
          homeId,
          userId: otherUser,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: otherMembership,
          homeId: otherHome,
          userId: leavingUser,
          role: 'ADMIN',
        });
        await insertEntry(
          supplies,
          database.pool,
          openEntry({
            id: leavingEntry,
            homeId,
            createdByMembershipId: adminMembership,
          }),
        );
        await insertEntry(
          supplies,
          database.pool,
          openEntry({
            id: stayingEntry,
            homeId,
            createdByMembershipId: adminMembership,
            title: 'Staying claim',
          }),
        );
        await insertEntry(
          supplies,
          database.pool,
          openEntry({
            id: otherEntry,
            homeId: otherHome,
            createdByMembershipId: otherMembership,
            title: 'Other home claim',
          }),
        );
        await insertClaim(
          supplies,
          database.pool,
          activeClaim({
            id: leavingClaim,
            homeId,
            supplyEntryId: leavingEntry,
            claimantMembershipId: leavingMembership,
          }),
        );
        await insertClaim(
          supplies,
          database.pool,
          activeClaim({
            id: stayingClaim,
            homeId,
            supplyEntryId: stayingEntry,
            claimantMembershipId: stayingMembership,
          }),
        );
        await insertClaim(
          supplies,
          database.pool,
          activeClaim({
            id: otherClaim,
            homeId: otherHome,
            supplyEntryId: otherEntry,
            claimantMembershipId: otherMembership,
          }),
        );

        await leaveCommand(database.pool)({
          homeId,
          membershipId: leavingMembership,
          actor: actor({
            userId: leavingUser,
            membershipId: leavingMembership,
            homeId,
            role: 'ROOMMATE',
          }),
        });

        const ended = await claimState(database.pool, leavingClaim);
        const staying = await claimState(database.pool, stayingClaim);
        const foreign = await claimState(database.pool, otherClaim);
        assert.equal(ended.releaseReason, 'MEMBERSHIP_ENDED');
        assert.deepEqual(ended.releasedAt, ENDED_AT);
        assert.equal(staying.releasedAt, null);
        assert.equal(staying.releaseReason, null);
        assert.equal(staying.claimantMembershipId, stayingMembership);
        assert.equal(foreign.releasedAt, null);
        assert.equal(foreign.releaseReason, null);
        assert.equal(foreign.homeId, otherHome);
        assert.equal(foreign.claimantMembershipId, otherMembership);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId, otherHome],
          userIds: [adminUser, leavingUser, otherUser],
        });
        await database.close();
      }
    },
  );

  void it(
    'keeps prior tenure history intact when a rejoined Membership later ends',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const supplies = createSupplyRepository(database.pool);
      const adminUser = randomUUID();
      const leavingUser = randomUUID();
      const homeId = randomUUID();
      const adminMembership = randomUUID();
      const firstMembership = randomUUID();
      const rejoinedMembership = randomUUID();
      const firstEntry = createUuidV7();
      const secondEntry = createUuidV7();
      const firstClaim = createUuidV7();
      const secondClaim = createUuidV7();

      try {
        await insertUser(database.pool, adminUser);
        await insertUser(database.pool, leavingUser);
        await insertHome(database.pool, homeId, 'Rejoin tenure');
        await insertMembership(database.pool, {
          id: adminMembership,
          homeId,
          userId: adminUser,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: firstMembership,
          homeId,
          userId: leavingUser,
          role: 'ROOMMATE',
        });
        await insertEntry(
          supplies,
          database.pool,
          openEntry({
            id: firstEntry,
            homeId,
            createdByMembershipId: adminMembership,
            title: 'First tenure',
          }),
        );
        await insertClaim(
          supplies,
          database.pool,
          activeClaim({
            id: firstClaim,
            homeId,
            supplyEntryId: firstEntry,
            claimantMembershipId: firstMembership,
          }),
        );

        await leaveCommand(database.pool)({
          homeId,
          membershipId: firstMembership,
          actor: actor({
            userId: leavingUser,
            membershipId: firstMembership,
            homeId,
            role: 'ROOMMATE',
          }),
        });

        const afterFirst = await claimState(database.pool, firstClaim);
        assert.equal(afterFirst.releaseReason, 'MEMBERSHIP_ENDED');
        assert.equal(afterFirst.claimantMembershipId, firstMembership);

        await insertMembership(database.pool, {
          id: rejoinedMembership,
          homeId,
          userId: leavingUser,
          role: 'ROOMMATE',
        });
        await insertEntry(
          supplies,
          database.pool,
          openEntry({
            id: secondEntry,
            homeId,
            createdByMembershipId: adminMembership,
            title: 'Second tenure',
          }),
        );
        await insertClaim(
          supplies,
          database.pool,
          activeClaim({
            id: secondClaim,
            homeId,
            supplyEntryId: secondEntry,
            claimantMembershipId: rejoinedMembership,
          }),
        );

        await leaveCommand(database.pool)({
          homeId,
          membershipId: rejoinedMembership,
          actor: actor({
            userId: leavingUser,
            membershipId: rejoinedMembership,
            homeId,
            role: 'ROOMMATE',
          }),
        });

        const firstHistory = await claimState(database.pool, firstClaim);
        const secondReleased = await claimState(database.pool, secondClaim);
        assert.deepEqual(firstHistory, afterFirst);
        assert.equal(firstHistory.claimantMembershipId, firstMembership);
        assert.equal(secondReleased.claimantMembershipId, rejoinedMembership);
        assert.equal(secondReleased.releaseReason, 'MEMBERSHIP_ENDED');
        assert.deepEqual(secondReleased.releasedAt, ENDED_AT);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [adminUser, leavingUser],
        });
        await database.close();
      }
    },
  );

  void it(
    'frees the active-claim unique slot so a later Membership can claim the same OPEN entry',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const supplies = createSupplyRepository(database.pool);
      const adminUser = randomUUID();
      const leavingUser = randomUUID();
      const laterUser = randomUUID();
      const homeId = randomUUID();
      const adminMembership = randomUUID();
      const leavingMembership = randomUUID();
      const laterMembership = randomUUID();
      const entryId = createUuidV7();
      const firstClaim = createUuidV7();
      const laterClaim = createUuidV7();

      try {
        await insertUser(database.pool, adminUser);
        await insertUser(database.pool, leavingUser);
        await insertUser(database.pool, laterUser);
        await insertHome(database.pool, homeId, 'Reclaim slot');
        await insertMembership(database.pool, {
          id: adminMembership,
          homeId,
          userId: adminUser,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: leavingMembership,
          homeId,
          userId: leavingUser,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: laterMembership,
          homeId,
          userId: laterUser,
          role: 'ROOMMATE',
        });
        await insertEntry(
          supplies,
          database.pool,
          openEntry({
            id: entryId,
            homeId,
            createdByMembershipId: adminMembership,
          }),
        );
        await insertClaim(
          supplies,
          database.pool,
          activeClaim({
            id: firstClaim,
            homeId,
            supplyEntryId: entryId,
            claimantMembershipId: leavingMembership,
          }),
        );

        await leaveCommand(database.pool)({
          homeId,
          membershipId: leavingMembership,
          actor: actor({
            userId: leavingUser,
            membershipId: leavingMembership,
            homeId,
            role: 'ROOMMATE',
          }),
        });

        await insertClaim(
          supplies,
          database.pool,
          activeClaim({
            id: laterClaim,
            homeId,
            supplyEntryId: entryId,
            claimantMembershipId: laterMembership,
          }),
        );

        const first = await claimState(database.pool, firstClaim);
        const later = await claimState(database.pool, laterClaim);
        const active = await supplies.findActiveClaimByEntry(homeId, entryId);
        assert.equal(first.releaseReason, 'MEMBERSHIP_ENDED');
        assert.equal(later.releasedAt, null);
        assert.equal(later.releaseReason, null);
        assert.equal(later.claimantMembershipId, laterMembership);
        assert.equal(active?.id, laterClaim);
        assert.equal((await entryState(database.pool, entryId)).status, 'OPEN');
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [adminUser, leavingUser, laterUser],
        });
        await database.close();
      }
    },
  );

  void it(
    'releases claims on admin removal with MEMBERSHIP_ENDED',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const supplies = createSupplyRepository(database.pool);
      const adminUser = randomUUID();
      const targetUser = randomUUID();
      const homeId = randomUUID();
      const adminMembership = randomUUID();
      const targetMembership = randomUUID();
      const entryId = createUuidV7();
      const claimId = createUuidV7();

      try {
        await insertUser(database.pool, adminUser);
        await insertUser(database.pool, targetUser);
        await insertHome(database.pool, homeId, 'Admin removal');
        await insertMembership(database.pool, {
          id: adminMembership,
          homeId,
          userId: adminUser,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: targetMembership,
          homeId,
          userId: targetUser,
          role: 'ROOMMATE',
        });
        await insertEntry(
          supplies,
          database.pool,
          openEntry({
            id: entryId,
            homeId,
            createdByMembershipId: adminMembership,
          }),
        );
        await insertClaim(
          supplies,
          database.pool,
          activeClaim({
            id: claimId,
            homeId,
            supplyEntryId: entryId,
            claimantMembershipId: targetMembership,
          }),
        );

        await removeCommand(database.pool)({
          homeId,
          membershipId: targetMembership,
          actor: actor({
            userId: adminUser,
            membershipId: adminMembership,
            homeId,
            role: 'ADMIN',
          }),
        });

        const released = await claimState(database.pool, claimId);
        assert.equal(released.releaseReason, 'MEMBERSHIP_ENDED');
        assert.deepEqual(released.releasedAt, ENDED_AT);
        assert.deepEqual(
          await membershipEndedAt(database.pool, targetMembership),
          ENDED_AT,
        );
        const events = await database.pool.query<{ cause: string }>(
          `SELECT payload->>'cause' AS cause FROM outbox_events
           WHERE home_id = $1 AND event_type = 'membership.ended.v1'`,
          [homeId],
        );
        assert.equal(events.rows[0]?.cause, 'ADMIN_REMOVAL');
        assert.equal((await entryState(database.pool, entryId)).status, 'OPEN');
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [adminUser, targetUser],
        });
        await database.close();
      }
    },
  );

  void it(
    'archives the final member with MEMBERSHIP_ENDED claims and one shared archive timestamp',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const supplies = createSupplyRepository(database.pool);
      const userId = randomUUID();
      const homeId = randomUUID();
      const membershipId = randomUUID();
      const firstEntry = createUuidV7();
      const secondEntry = createUuidV7();
      const firstClaim = createUuidV7();
      const secondClaim = createUuidV7();

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, homeId, 'Archive claims');
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ADMIN',
        });
        await insertEntry(
          supplies,
          database.pool,
          openEntry({
            id: firstEntry,
            homeId,
            createdByMembershipId: membershipId,
            title: 'Archive A',
          }),
        );
        await insertEntry(
          supplies,
          database.pool,
          openEntry({
            id: secondEntry,
            homeId,
            createdByMembershipId: membershipId,
            title: 'Archive B',
          }),
        );
        await insertClaim(
          supplies,
          database.pool,
          activeClaim({
            id: firstClaim,
            homeId,
            supplyEntryId: firstEntry,
            claimantMembershipId: membershipId,
          }),
        );
        await insertClaim(
          supplies,
          database.pool,
          activeClaim({
            id: secondClaim,
            homeId,
            supplyEntryId: secondEntry,
            claimantMembershipId: membershipId,
          }),
        );

        const archive = createArchiveFinalMemberHome({
          runTransaction: (work) =>
            runInReadCommittedTransaction(database.pool, work),
          lockHomeStructure,
          clock: { now: () => ARCHIVE_AT },
          invitationRevoker: {
            lockPendingForHomeArchive() {
              return Promise.resolve();
            },
            revokeLockedPendingForHomeArchive() {
              return Promise.resolve();
            },
          },
          applyMembershipEnding:
            createApplyMembershipEndingWithinHomeStructureFromPool(
              database.pool,
            ),
          homeArchive: createHomeArchiveWriter(),
          outbox: createOutboxWriter(),
          ids: { next: nextEventId },
        });

        await archive({
          homeId,
          actor: actor({
            userId,
            membershipId,
            homeId,
            role: 'ADMIN',
          }),
        });

        const first = await claimState(database.pool, firstClaim);
        const second = await claimState(database.pool, secondClaim);
        const endedAt = await membershipEndedAt(database.pool, membershipId);
        const home = await database.pool.query<{ archived_at: Date | null }>(
          'SELECT archived_at FROM homes WHERE id = $1',
          [homeId],
        );
        const occurred = await database.pool.query<{ occurred_at: Date }>(
          `SELECT occurred_at FROM outbox_events
           WHERE home_id = $1 ORDER BY event_type`,
          [homeId],
        );
        assert.equal(first.releaseReason, 'MEMBERSHIP_ENDED');
        assert.equal(second.releaseReason, 'MEMBERSHIP_ENDED');
        assert.deepEqual(first.releasedAt, ARCHIVE_AT);
        assert.deepEqual(first.updatedAt, ARCHIVE_AT);
        assert.deepEqual(second.releasedAt, ARCHIVE_AT);
        assert.deepEqual(second.updatedAt, ARCHIVE_AT);
        assert.equal(first.claimantMembershipId, membershipId);
        assert.equal(second.claimantMembershipId, membershipId);
        assert.deepEqual(endedAt, ARCHIVE_AT);
        assert.deepEqual(home.rows[0]?.archived_at, ARCHIVE_AT);
        assert.deepEqual(first.releasedAt, endedAt);
        assert.deepEqual(endedAt, home.rows[0]?.archived_at);
        assert.equal(occurred.rows.length, 2);
        assert.deepEqual(occurred.rows[0]?.occurred_at, ARCHIVE_AT);
        assert.deepEqual(occurred.rows[1]?.occurred_at, ARCHIVE_AT);
        assert.deepEqual(await outboxTypes(database.pool, homeId), [
          'home.archived.v1',
          'membership.ended.v1',
        ]);
        assert.equal(
          (await entryState(database.pool, firstEntry)).status,
          'OPEN',
        );
        assert.equal(
          (await entryState(database.pool, secondEntry)).status,
          'OPEN',
        );
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
    'rolls Supply claim release back when a later membership-ending step fails',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const supplies = createSupplyRepository(database.pool);
      const adminUser = randomUUID();
      const leavingUser = randomUUID();
      const homeId = randomUUID();
      const adminMembership = randomUUID();
      const leavingMembership = randomUUID();
      const entryId = createUuidV7();
      const claimId = createUuidV7();
      const taskId = createUuidV7();
      const endMembership = createEndMembershipWithinHomeStructure({
        taskCleanup: createMembershipEndingTaskCleanupFromPool(database.pool),
        supplyCleanup: createMembershipEndingSupplyCleanupFromPool(
          database.pool,
        ),
        membershipEnding: {
          endActiveMembership() {
            return Promise.reject(
              new Error('injected membership writer failure'),
            );
          },
        },
        outbox: createOutboxWriter(),
        ids: { next: nextEventId },
      });

      try {
        await insertUser(database.pool, adminUser);
        await insertUser(database.pool, leavingUser);
        await insertHome(database.pool, homeId, 'Rollback after cleanup');
        await insertMembership(database.pool, {
          id: adminMembership,
          homeId,
          userId: adminUser,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: leavingMembership,
          homeId,
          userId: leavingUser,
          role: 'ROOMMATE',
        });
        await database.pool.query(
          `INSERT INTO task_instances (
             id, home_id, source, status, title, scheduled_for,
             assigned_membership_id, task_definition_id, completed_at,
             created_at, updated_at
           ) VALUES (
             $1::uuid, $2::uuid, 'MANUAL', 'OPEN', 'Should roll back', NULL,
             $3::uuid, NULL, NULL, $4::timestamptz, $4::timestamptz
           )`,
          [taskId, homeId, leavingMembership, CREATED_AT],
        );
        await insertEntry(
          supplies,
          database.pool,
          openEntry({
            id: entryId,
            homeId,
            createdByMembershipId: adminMembership,
          }),
        );
        await insertClaim(
          supplies,
          database.pool,
          activeClaim({
            id: claimId,
            homeId,
            supplyEntryId: entryId,
            claimantMembershipId: leavingMembership,
          }),
        );

        await assert.rejects(
          () =>
            runInReadCommittedTransaction(database.pool, async (tx) => {
              await lockHomeStructure(tx, {
                homeId,
                actor: actor({
                  userId: leavingUser,
                  membershipId: leavingMembership,
                  homeId,
                  role: 'ROOMMATE',
                }),
              });
              await endMembership(tx, {
                homeId,
                membershipId: leavingMembership,
                endedAt: ENDED_AT,
                cause: 'VOLUNTARY_LEAVE',
              });
            }),
          /injected membership writer failure/,
        );

        const claim = await claimState(database.pool, claimId);
        assert.equal(claim.releasedAt, null);
        assert.equal(claim.releaseReason, null);
        assert.deepEqual(claim.updatedAt, CLAIMED_AT);
        assert.equal(claim.claimantMembershipId, leavingMembership);
        assert.equal(
          await membershipEndedAt(database.pool, leavingMembership),
          null,
        );
        const task = await database.pool.query<{
          assigned_membership_id: string | null;
        }>('SELECT assigned_membership_id FROM task_instances WHERE id = $1', [
          taskId,
        ]);
        assert.equal(task.rows[0]?.assigned_membership_id, leavingMembership);
        assert.deepEqual(await outboxTypes(database.pool, homeId), []);
        const home = await database.pool.query<{ archived_at: Date | null }>(
          'SELECT archived_at FROM homes WHERE id = $1',
          [homeId],
        );
        assert.equal(home.rows[0]?.archived_at, null);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [adminUser, leavingUser],
        });
        await database.close();
      }
    },
  );

  void it(
    'rolls Supply claim release back when outbox append fails after cleanup',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const supplies = createSupplyRepository(database.pool);
      const adminUser = randomUUID();
      const leavingUser = randomUUID();
      const homeId = randomUUID();
      const adminMembership = randomUUID();
      const leavingMembership = randomUUID();
      const entryId = createUuidV7();
      const claimId = createUuidV7();
      const endMembership = createEndMembershipWithinHomeStructure({
        taskCleanup: createMembershipEndingTaskCleanupFromPool(database.pool),
        supplyCleanup: createMembershipEndingSupplyCleanupFromPool(
          database.pool,
        ),
        membershipEnding: createMembershipEndingWriter(),
        outbox: {
          append() {
            return Promise.reject(new Error('injected outbox failure'));
          },
        },
        ids: { next: nextEventId },
      });

      try {
        await insertUser(database.pool, adminUser);
        await insertUser(database.pool, leavingUser);
        await insertHome(database.pool, homeId, 'Outbox rollback');
        await insertMembership(database.pool, {
          id: adminMembership,
          homeId,
          userId: adminUser,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: leavingMembership,
          homeId,
          userId: leavingUser,
          role: 'ROOMMATE',
        });
        await insertEntry(
          supplies,
          database.pool,
          openEntry({
            id: entryId,
            homeId,
            createdByMembershipId: adminMembership,
          }),
        );
        await insertClaim(
          supplies,
          database.pool,
          activeClaim({
            id: claimId,
            homeId,
            supplyEntryId: entryId,
            claimantMembershipId: leavingMembership,
          }),
        );

        await assert.rejects(
          () =>
            runInReadCommittedTransaction(database.pool, async (tx) => {
              await lockHomeStructure(tx, {
                homeId,
                actor: actor({
                  userId: leavingUser,
                  membershipId: leavingMembership,
                  homeId,
                  role: 'ROOMMATE',
                }),
              });
              await endMembership(tx, {
                homeId,
                membershipId: leavingMembership,
                endedAt: ENDED_AT,
                cause: 'VOLUNTARY_LEAVE',
              });
            }),
          /injected outbox failure/,
        );

        const claim = await claimState(database.pool, claimId);
        assert.equal(claim.releasedAt, null);
        assert.equal(claim.releaseReason, null);
        assert.deepEqual(claim.updatedAt, CLAIMED_AT);
        assert.equal(
          await membershipEndedAt(database.pool, leavingMembership),
          null,
        );
        assert.deepEqual(await outboxTypes(database.pool, homeId), []);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [adminUser, leavingUser],
        });
        await database.close();
      }
    },
  );

  void it(
    'uses the Membership-ending cleanup index for the exact Home and Membership predicate',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const supplies = createSupplyRepository(database.pool);
      const adminUser = randomUUID();
      const leavingUser = randomUUID();
      const homeId = randomUUID();
      const adminMembership = randomUUID();
      const leavingMembership = randomUUID();
      const entryId = createUuidV7();
      const claimId = createUuidV7();

      try {
        await insertUser(database.pool, adminUser);
        await insertUser(database.pool, leavingUser);
        await insertHome(database.pool, homeId, 'Index shape');
        await insertMembership(database.pool, {
          id: adminMembership,
          homeId,
          userId: adminUser,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: leavingMembership,
          homeId,
          userId: leavingUser,
          role: 'ROOMMATE',
        });
        await insertEntry(
          supplies,
          database.pool,
          openEntry({
            id: entryId,
            homeId,
            createdByMembershipId: adminMembership,
          }),
        );
        await insertClaim(
          supplies,
          database.pool,
          activeClaim({
            id: claimId,
            homeId,
            supplyEntryId: entryId,
            claimantMembershipId: leavingMembership,
          }),
        );

        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await tx.query('SET LOCAL enable_seqscan = off');
          const selectPlan = await tx.query<{ 'QUERY PLAN': string }>(
            `EXPLAIN (COSTS OFF)
             SELECT id FROM supply_claims
             WHERE home_id = $1::uuid
               AND claimant_membership_id = $2::uuid
               AND released_at IS NULL
             ORDER BY id`,
            [homeId, leavingMembership],
          );
          const updatePlan = await tx.query<{ 'QUERY PLAN': string }>(
            `EXPLAIN (COSTS OFF)
             UPDATE supply_claims
             SET
               released_at = $3::timestamptz,
               release_reason = 'MEMBERSHIP_ENDED',
               updated_at = $3::timestamptz
             WHERE home_id = $1::uuid
               AND claimant_membership_id = $2::uuid
               AND released_at IS NULL`,
            [homeId, leavingMembership, ENDED_AT],
          );
          const selectText = selectPlan.rows
            .map((row) => row['QUERY PLAN'])
            .join('\n');
          const updateText = updatePlan.rows
            .map((row) => row['QUERY PLAN'])
            .join('\n');
          assert.match(
            selectText,
            /supply_claims_home_active_claimant_idx_2b0b42e6/,
          );
          assert.match(updateText, /Index Scan/);
          assert.doesNotMatch(updateText, /Seq Scan/);
        });
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [adminUser, leavingUser],
        });
        await database.close();
      }
    },
  );
});
