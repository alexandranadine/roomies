import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { lockHomeAndExactMemberships } from '../../domains/homes/lock-home-and-exact-memberships.js';
import { SupplyNotOpenError } from '../../domains/supplies/errors.js';
import { SUPPLY_OBTAINED_V1 } from '../../domains/supplies/events.js';
import { createSupplyRepository } from '../../domains/supplies/repository.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import type { AppConfig } from '../../platform/config/types.js';
import { outboxWriter } from '../../platform/events/outbox-writer.js';
import { createUuidV7, systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import { createCancelSupplyEntryFromPool } from './cancel-supply-entry.js';
import { createClaimSupplyEntryFromPool } from './claim-supply-entry.js';
import { createCreateSupplyEntryFromPool } from './create-supply-entry.js';
import {
  createMarkSupplyEntryObtained,
  createMarkSupplyEntryObtainedFromPool,
} from './mark-supply-entry-obtained.js';
import { createReleaseSupplyClaimFromPool } from './release-supply-claim.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const TITLE_SENTINEL = 'SENTINEL_SUPPLY_TITLE_LEAK_M64A';
const OCCURRED = new Date('2026-12-31T20:00:00.000Z');

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

async function insertUser(pool: Pool, userId: string): Promise<void> {
  await pool.query('INSERT INTO users (id, updated_at) VALUES ($1, NOW())', [
    userId,
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
    await pool.query('DELETE FROM activities WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query('DELETE FROM supply_claims WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
    await pool.query('DELETE FROM supply_entries WHERE home_id = ANY($1)', [
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

type OutboxRow = {
  event_id: string;
  event_type: string;
  occurred_at: Date;
  home_id: string | null;
  payload: unknown;
};

async function supplyEvents(
  pool: Pool,
  homeId: string,
): Promise<readonly OutboxRow[]> {
  const result = await pool.query<OutboxRow>(
    `SELECT event_id, event_type, occurred_at, home_id, payload
     FROM outbox_events
     WHERE home_id = $1
       AND event_type LIKE 'supply%'
     ORDER BY created_at ASC, event_id ASC`,
    [homeId],
  );
  return result.rows;
}

async function claimRow(
  pool: Pool,
  claimId: string,
): Promise<{
  releasedAt: Date | null;
  releaseReason: string | null;
  claimantMembershipId: string;
}> {
  const result = await pool.query<{
    released_at: Date | null;
    release_reason: string | null;
    claimant_membership_id: string;
  }>(
    `SELECT released_at, release_reason, claimant_membership_id
     FROM supply_claims WHERE id = $1`,
    [claimId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('claim missing');
  }
  return {
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
    claimantMembershipId: row.claimant_membership_id,
  };
}

void describe('Supply outbox event production PostgreSQL', () => {
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
    'emits exactly one supply.obtained.v1 atomically with claim closure',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const create = createCreateSupplyEntryFromPool(database.pool);
      const claim = createClaimSupplyEntryFromPool(database.pool);
      const release = createReleaseSupplyClaimFromPool(database.pool);
      const cancel = createCancelSupplyEntryFromPool(database.pool);
      const obtain = createMarkSupplyEntryObtainedFromPool(database.pool);
      const userAlex = randomUUID();
      const userJamie = randomUUID();
      const homeId = createUuidV7();
      const alex = createUuidV7();
      const jamie = createUuidV7();

      try {
        await insertUser(database.pool, userAlex);
        await insertUser(database.pool, userJamie);
        await insertHome(database.pool, { id: homeId, name: 'Supply events' });
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

        const created = await create({
          actor: jamieActor,
          homeId,
          title: TITLE_SENTINEL,
        });
        assert.equal((await supplyEvents(database.pool, homeId)).length, 0);

        const claimed = await claim({
          actor: jamieActor,
          homeId,
          supplyEntryId: created.id,
        });
        assert.equal((await supplyEvents(database.pool, homeId)).length, 0);

        const obtained = await obtain({
          actor: alexActor,
          homeId,
          supplyEntryId: created.id,
        });
        assert.equal(obtained.status, 'OBTAINED');
        assert.equal(obtained.obtainedByMembershipId, alex);
        assert.notEqual(obtained.obtainedByMembershipId, jamie);
        assert.notEqual(
          obtained.obtainedByMembershipId,
          created.createdByMembershipId,
        );

        const closed = await claimRow(database.pool, claimed.id);
        assert.equal(closed.claimantMembershipId, jamie);
        assert.equal(closed.releaseReason, 'ENTRY_OBTAINED');
        assert.equal(
          closed.releasedAt?.getTime(),
          obtained.obtainedAt?.getTime(),
        );

        const events = await supplyEvents(database.pool, homeId);
        assert.equal(events.length, 1);
        assert.equal(events[0]?.event_type, SUPPLY_OBTAINED_V1);
        assert.equal(events[0]?.home_id, homeId);
        assert.equal(
          events[0]?.occurred_at.getTime(),
          obtained.obtainedAt?.getTime(),
        );
        assert.deepEqual(events[0]?.payload, { supplyEntryId: created.id });
        assert.deepEqual(Object.keys(events[0]?.payload ?? {}), [
          'supplyEntryId',
        ]);
        const json = JSON.stringify(events[0]?.payload);
        assert.equal(json.includes(TITLE_SENTINEL), false);
        assert.equal(json.includes(userAlex), false);
        assert.equal(json.includes(userJamie), false);
        assert.equal(json.includes(alex), false);
        assert.equal(json.includes(jamie), false);
        assert.equal(json.includes('claimant'), false);

        await assert.rejects(
          () =>
            obtain({
              actor: alexActor,
              homeId,
              supplyEntryId: created.id,
            }),
          SupplyNotOpenError,
        );
        assert.equal((await supplyEvents(database.pool, homeId)).length, 1);

        const toCancel = await create({
          actor: alexActor,
          homeId,
          title: TITLE_SENTINEL,
        });
        await cancel({
          actor: alexActor,
          homeId,
          supplyEntryId: toCancel.id,
        });
        assert.equal((await supplyEvents(database.pool, homeId)).length, 1);

        const toRelease = await create({
          actor: alexActor,
          homeId,
          title: TITLE_SENTINEL,
        });
        await claim({
          actor: jamieActor,
          homeId,
          supplyEntryId: toRelease.id,
        });
        await release({
          actor: jamieActor,
          homeId,
          supplyEntryId: toRelease.id,
        });
        assert.equal((await supplyEvents(database.pool, homeId)).length, 1);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userAlex, userJamie],
        });
        await database.close();
      }
    },
  );

  void it(
    'emits no event on unauthorized obtain or rolled-back obtain',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const create = createCreateSupplyEntryFromPool(database.pool);
      const claim = createClaimSupplyEntryFromPool(database.pool);
      const obtain = createMarkSupplyEntryObtainedFromPool(database.pool);
      const supplies = createSupplyRepository(database.pool);
      const userA = randomUUID();
      const userB = randomUUID();
      const homeA = createUuidV7();
      const homeB = createUuidV7();
      const membershipA = createUuidV7();
      const membershipB = createUuidV7();

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeA, name: 'Fail A' });
        await insertHome(database.pool, { id: homeB, name: 'Fail B' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId: homeA,
          userId: userA,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId: homeB,
          userId: userB,
          role: 'ROOMMATE',
        });
        const actorA = actor({
          userId: userA,
          membershipId: membershipA,
          homeId: homeA,
          role: 'ROOMMATE',
        });
        const actorB = actor({
          userId: userB,
          membershipId: membershipB,
          homeId: homeB,
          role: 'ROOMMATE',
        });
        const created = await create({
          actor: actorA,
          homeId: homeA,
          title: TITLE_SENTINEL,
        });
        const claimed = await claim({
          actor: actorA,
          homeId: homeA,
          supplyEntryId: created.id,
        });

        await assert.rejects(
          () =>
            obtain({
              actor: actorB,
              homeId: homeA,
              supplyEntryId: created.id,
            }),
          ConcealedNotFoundError,
        );
        assert.equal((await supplyEvents(database.pool, homeA)).length, 0);

        await assert.rejects(
          () =>
            createMarkSupplyEntryObtained({
              runTransaction: (work) =>
                runInReadCommittedTransaction(database.pool, work),
              lockHomeAndExactMemberships,
              supplies,
              outbox: {
                async append(tx, event) {
                  await outboxWriter.append(tx, event);
                  throw new Error('force rollback after event');
                },
              },
              clock: { now: () => OCCURRED },
              ids: systemUuidV7,
            })({
              actor: actorA,
              homeId: homeA,
              supplyEntryId: created.id,
            }),
          /force rollback after event/,
        );

        const entry = await database.pool.query<{
          status: string;
          obtained_at: Date | null;
          obtained_by_membership_id: string | null;
        }>(
          `SELECT status, obtained_at, obtained_by_membership_id
           FROM supply_entries WHERE id = $1`,
          [created.id],
        );
        assert.equal(entry.rows[0]?.status, 'OPEN');
        assert.equal(entry.rows[0]?.obtained_at, null);
        assert.equal(entry.rows[0]?.obtained_by_membership_id, null);
        const leftoverClaim = await claimRow(database.pool, claimed.id);
        assert.equal(leftoverClaim.releasedAt, null);
        assert.equal(leftoverClaim.releaseReason, null);
        assert.equal((await supplyEvents(database.pool, homeA)).length, 0);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeA, homeB],
          userIds: [userA, userB],
        });
        await database.close();
      }
    },
  );
});
