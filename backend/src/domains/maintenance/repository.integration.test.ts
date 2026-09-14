import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import type { AppConfig } from '../../platform/config/types.js';
import {
  decodeMaintenanceListCursor,
  MAINTENANCE_LIST_QUERY_FINGERPRINT,
} from './cursor.js';
import { InvalidMaintenanceRequestError } from './errors.js';
import {
  createMaintenanceRepository,
  type NewMaintenanceEntry,
} from './repository.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const CREATED = new Date('2026-09-13T12:00:00.000Z');
const T1 = new Date('2026-09-13T12:10:00.000Z');
const T2 = new Date('2026-09-13T12:20:00.000Z');
const T3 = new Date('2026-09-13T12:30:00.000Z');

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

type Sentinel = {
  users: readonly [string, string, string];
  homeId: string;
  otherHomeId: string;
  alex: string;
  jamie: string;
  taylor: string;
  otherMembership: string;
  privateA: string;
  privateB: string;
  householdH: string;
};

async function insertUser(pool: Pool, userId: string): Promise<void> {
  await pool.query('INSERT INTO users (id, updated_at) VALUES ($1, NOW())', [
    userId,
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

function entryInput(
  id: string,
  homeId: string,
  createdByMembershipId: string,
  visibility: 'HOUSEHOLD' | 'PRIVATE',
  title: string,
  updatedAt = CREATED,
): NewMaintenanceEntry {
  return {
    id,
    homeId,
    createdByMembershipId,
    visibility,
    title,
    details: null,
    status: 'OPEN',
    resolvedByMembershipId: null,
    resolvedAt: null,
    createdAt: CREATED,
    updatedAt,
  };
}

async function cleanup(
  pool: Pool,
  input: { userIds: string[]; homeIds: string[] },
): Promise<void> {
  if (input.homeIds.length > 0) {
    await pool.query(
      'DELETE FROM maintenance_audiences WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query(
      'DELETE FROM maintenance_entries WHERE home_id = ANY($1::uuid[])',
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
    await pool.query('DELETE FROM homes WHERE id = ANY($1::uuid[])', [
      input.homeIds,
    ]);
  }
  if (input.userIds.length > 0) {
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
      input.userIds,
    ]);
  }
}

async function createSentinel(pool: Pool): Promise<Sentinel> {
  const repository = createMaintenanceRepository(pool);
  const users = [createUuidV7(), createUuidV7(), createUuidV7()] as const;
  const homeId = createUuidV7();
  const otherHomeId = createUuidV7();
  const alex = createUuidV7();
  const jamie = createUuidV7();
  const taylor = createUuidV7();
  const otherMembership = createUuidV7();
  const privateA = createUuidV7();
  const privateB = createUuidV7();
  const householdH = createUuidV7();
  await insertUser(pool, users[0]);
  await insertUser(pool, users[1]);
  await insertUser(pool, users[2]);
  await insertHome(pool, { id: homeId, name: 'Maintenance sentinel' });
  await insertHome(pool, { id: otherHomeId, name: 'Other home' });
  await insertMembership(pool, {
    id: alex,
    homeId,
    userId: users[0],
    role: 'ROOMMATE',
  });
  await insertMembership(pool, {
    id: jamie,
    homeId,
    userId: users[1],
    role: 'ROOMMATE',
  });
  await insertMembership(pool, {
    id: taylor,
    homeId,
    userId: users[2],
    role: 'ADMIN',
  });
  await insertMembership(pool, {
    id: otherMembership,
    homeId: otherHomeId,
    userId: users[2],
    role: 'ADMIN',
  });
  await runInReadCommittedTransaction(pool, async (tx) => {
    await repository.insertEntryWithAudience(tx, {
      entry: entryInput(privateA, homeId, alex, 'PRIVATE', 'Private A', T2),
      audienceMembershipIds: [alex],
    });
    await repository.insertEntryWithAudience(tx, {
      entry: entryInput(privateB, homeId, jamie, 'PRIVATE', 'Private B', T1),
      audienceMembershipIds: [jamie],
    });
    await repository.insertEntryWithAudience(tx, {
      entry: entryInput(
        householdH,
        homeId,
        taylor,
        'HOUSEHOLD',
        'Household H',
        T3,
      ),
      audienceMembershipIds: [],
    });
  });
  return {
    users,
    homeId,
    otherHomeId,
    alex,
    jamie,
    taylor,
    otherMembership,
    privateA,
    privateB,
    householdH,
  };
}

void describe('Maintenance repository PostgreSQL', () => {
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
    'enforces the Alex/Jamie/Taylor privacy sentinel on every read helper',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const repository = createMaintenanceRepository(database.pool);
      let sentinel: Sentinel | undefined;
      try {
        sentinel = await createSentinel(database.pool);
        const fixture = sentinel;
        const ids = async (actor: string, limit = 25, cursor?: string) => {
          const page = await repository.listVisibleByHome({
            homeId: sentinel!.homeId,
            actorMembershipId: actor,
            limit,
            cursor,
          });
          return page;
        };

        const alexPage = await ids(sentinel.alex);
        const jamiePage = await ids(sentinel.jamie);
        const taylorPage = await ids(sentinel.taylor);
        assert.deepEqual(
          alexPage?.items.map((item) => item.id),
          [sentinel.householdH, sentinel.privateA],
        );
        assert.deepEqual(
          jamiePage?.items.map((item) => item.id),
          [sentinel.householdH, sentinel.privateB],
        );
        assert.deepEqual(
          taylorPage?.items.map((item) => item.id),
          [sentinel.householdH],
        );
        assert.equal(
          alexPage?.items.some((item) => item.id === fixture.privateB),
          false,
        );
        assert.equal(
          jamiePage?.items.some((item) => item.id === fixture.privateA),
          false,
        );
        assert.equal(
          taylorPage?.items.some((item) => item.id === fixture.privateA),
          false,
        );
        assert.equal(
          taylorPage?.items.some((item) => item.id === fixture.privateB),
          false,
        );

        assert.equal(
          (
            await repository.findVisibleByHomeAndId(
              sentinel.homeId,
              sentinel.privateA,
              sentinel.alex,
            )
          )?.id,
          sentinel.privateA,
        );
        assert.equal(
          await repository.findVisibleByHomeAndId(
            sentinel.homeId,
            sentinel.privateB,
            sentinel.alex,
          ),
          null,
        );
        assert.equal(
          await repository.findVisibleByHomeAndId(
            sentinel.homeId,
            sentinel.privateA,
            sentinel.jamie,
          ),
          null,
        );
        assert.equal(
          await repository.findVisibleByHomeAndId(
            sentinel.homeId,
            sentinel.privateA,
            sentinel.taylor,
          ),
          null,
        );
        assert.equal(
          (
            await repository.findVisibleByHomeAndId(
              sentinel.homeId,
              sentinel.householdH,
              sentinel.taylor,
            )
          )?.id,
          sentinel.householdH,
        );
        assert.equal(
          (
            await repository.findVisibleByHomeAndId(
              sentinel.homeId,
              sentinel.householdH,
              sentinel.alex,
            )
          )?.id,
          sentinel.householdH,
        );
        assert.equal(
          await repository.findVisibleByHomeAndId(
            sentinel.otherHomeId,
            sentinel.privateA,
            sentinel.otherMembership,
          ),
          null,
        );
        assert.equal(
          await repository.findVisibleByHomeAndId(
            sentinel.homeId,
            createUuidV7(),
            sentinel.alex,
          ),
          null,
        );

        await runInReadCommittedTransaction(database.pool, async (tx) => {
          assert.equal(
            (
              await repository.lockVisibleForResolve(
                tx,
                sentinel!.homeId,
                sentinel!.privateA,
                sentinel!.alex,
              )
            )?.id,
            sentinel!.privateA,
          );
          assert.equal(
            await repository.lockVisibleForResolve(
              tx,
              sentinel!.homeId,
              sentinel!.privateB,
              sentinel!.alex,
            ),
            null,
          );
          assert.equal(
            await repository.lockVisibleForResolve(
              tx,
              sentinel!.homeId,
              sentinel!.privateA,
              sentinel!.taylor,
            ),
            null,
          );
          assert.equal(
            (
              await repository.lockVisibleForResolve(
                tx,
                sentinel!.homeId,
                sentinel!.householdH,
                sentinel!.taylor,
              )
            )?.id,
            sentinel!.householdH,
          );
        });

        const alexFirst = await ids(sentinel.alex, 1);
        assert.deepEqual(
          alexFirst?.items.map((item) => item.id),
          [sentinel.householdH],
        );
        assert.equal(alexFirst?.hasMore, true);
        const alexCursor = alexFirst?.nextCursor;
        assert.equal(typeof alexCursor, 'string');
        if (alexCursor === undefined || alexCursor === null) {
          assert.fail('expected a continuation cursor');
        }
        const alexNext = await ids(sentinel.alex, 1, alexCursor);
        assert.deepEqual(
          alexNext?.items.map((item) => item.id),
          [sentinel.privateA],
        );
        assert.equal(alexNext?.hasMore, false);
        const cursor = decodeMaintenanceListCursor(alexCursor);
        assert.equal(cursor.id, sentinel.householdH);
        assert.equal(cursor.homeId, sentinel.homeId);
        assert.equal(cursor.actorMembershipId, sentinel.alex);
        assert.equal(
          cursor.queryFingerprint,
          MAINTENANCE_LIST_QUERY_FINGERPRINT,
        );
        assert.equal(cursor.statusFilter, null);
        assert.equal('audience' in cursor, false);

        const beforeHidden = JSON.stringify(alexPage);
        const hidden = createUuidV7();
        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await repository.insertEntryWithAudience(tx, {
            entry: entryInput(
              hidden,
              sentinel!.homeId,
              sentinel!.jamie,
              'PRIVATE',
              'Hidden from Alex',
              new Date('2026-09-13T15:00:00.000Z'),
            ),
            audienceMembershipIds: [sentinel!.jamie],
          });
        });
        const afterHidden = await ids(sentinel.alex);
        assert.equal(JSON.stringify(afterHidden), beforeHidden);
        const afterFirst = await ids(sentinel.alex, 1);
        assert.equal(afterFirst?.nextCursor, alexFirst?.nextCursor);
        assert.equal(afterFirst?.hasMore, true);

        await assert.rejects(
          () =>
            repository.listVisibleByHome({
              homeId: sentinel!.homeId,
              actorMembershipId: sentinel!.alex,
              limit: 25,
              cursor: '%%%',
            }),
          InvalidMaintenanceRequestError,
        );
        await assert.rejects(
          () =>
            repository.listVisibleByHome({
              homeId: sentinel!.otherHomeId,
              actorMembershipId: sentinel!.alex,
              limit: 25,
              cursor: alexFirst?.nextCursor ?? undefined,
            }),
          InvalidMaintenanceRequestError,
        );
        await assert.rejects(
          () =>
            repository.listVisibleByHome({
              homeId: sentinel!.homeId,
              actorMembershipId: sentinel!.jamie,
              limit: 25,
              cursor: alexFirst?.nextCursor ?? undefined,
            }),
          InvalidMaintenanceRequestError,
        );
        await assert.rejects(
          () =>
            repository.listVisibleByHome({
              homeId: sentinel!.homeId,
              actorMembershipId: sentinel!.alex,
              limit: 25,
              status: 'OPEN',
              cursor: alexFirst?.nextCursor ?? undefined,
            }),
          InvalidMaintenanceRequestError,
        );
        await assert.rejects(
          () =>
            repository.listVisibleByHome({
              homeId: sentinel!.homeId,
              actorMembershipId: sentinel!.alex,
              limit: 25,
              cursor: Buffer.from(
                JSON.stringify({
                  ...cursor,
                  queryFingerprint: 'b'.repeat(64),
                }),
                'utf8',
              ).toString('base64url'),
            }),
          InvalidMaintenanceRequestError,
        );
      } finally {
        if (sentinel) {
          await cleanup(database.pool, {
            userIds: [...sentinel.users],
            homeIds: [sentinel.homeId, sentinel.otherHomeId],
          });
        }
        await database.close();
      }
    },
  );

  void it(
    'proves exact-tenure, archive, ended-actor, and empty-vs-stale list',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const repository = createMaintenanceRepository(database.pool);
      const userId = createUuidV7();
      const homeId = createUuidV7();
      const archivedHome = createUuidV7();
      const membershipA = createUuidV7();
      const membershipB = createUuidV7();
      const archivedMembership = createUuidV7();
      const entryId = createUuidV7();
      const archivedEntry = createUuidV7();
      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, { id: homeId, name: 'Tenure home' });
        await insertHome(database.pool, {
          id: archivedHome,
          name: 'Archived',
          archived: true,
        });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: archivedMembership,
          homeId: archivedHome,
          userId,
          role: 'ADMIN',
        });
        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await repository.insertEntryWithAudience(tx, {
            entry: entryInput(
              entryId,
              homeId,
              membershipA,
              'PRIVATE',
              'Tenure',
            ),
            audienceMembershipIds: [membershipA],
          });
          await repository.insertEntryWithAudience(tx, {
            entry: entryInput(
              archivedEntry,
              archivedHome,
              archivedMembership,
              'HOUSEHOLD',
              'Archived household',
            ),
            audienceMembershipIds: [],
          });
        });

        assert.equal(
          (
            await repository.findVisibleByHomeAndId(
              homeId,
              entryId,
              membershipA,
            )
          )?.id,
          entryId,
        );
        await database.pool.query(
          'UPDATE memberships SET ended_at = NOW(), ended_by_membership_id = $1 WHERE id = $1',
          [membershipA],
        );
        assert.equal(
          await repository.findVisibleByHomeAndId(homeId, entryId, membershipA),
          null,
        );
        assert.equal(
          await repository.listVisibleByHome({
            homeId,
            actorMembershipId: membershipA,
            limit: 25,
          }),
          null,
        );
        const remaining = await database.pool.query<{ membership_id: string }>(
          `SELECT membership_id FROM maintenance_audiences
           WHERE maintenance_entry_id = $1`,
          [entryId],
        );
        assert.deepEqual(
          remaining.rows.map((row) => row.membership_id),
          [membershipA],
        );

        await insertMembership(database.pool, {
          id: membershipB,
          homeId,
          userId,
          role: 'ROOMMATE',
        });
        assert.equal(
          await repository.findVisibleByHomeAndId(homeId, entryId, membershipB),
          null,
        );
        const rejoined = await repository.listVisibleByHome({
          homeId,
          actorMembershipId: membershipB,
          limit: 25,
        });
        assert.deepEqual(rejoined?.items, []);
        assert.equal(rejoined?.hasMore, false);

        assert.equal(
          await repository.findVisibleByHomeAndId(
            archivedHome,
            archivedEntry,
            archivedMembership,
          ),
          null,
        );
        assert.equal(
          await repository.listVisibleByHome({
            homeId: archivedHome,
            actorMembershipId: archivedMembership,
            limit: 25,
          }),
          null,
        );
      } finally {
        await cleanup(database.pool, {
          userIds: [userId],
          homeIds: [homeId, archivedHome],
        });
        await database.close();
      }
    },
  );

  void it(
    'orders, paginates, and resolves through persistence primitives',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const repository = createMaintenanceRepository(database.pool);
      const userId = createUuidV7();
      const homeId = createUuidV7();
      const actor = createUuidV7();
      const openNew = '41000000-0000-7000-8000-0000000000aa';
      const openOld = '41000000-0000-7000-8000-0000000000bb';
      const openTieHigh = '41000000-0000-7000-8000-0000000000ff';
      const openTieLow = '41000000-0000-7000-8000-000000000011';
      const resolved = '41000000-0000-7000-8000-0000000000cc';
      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, { id: homeId, name: 'Order home' });
        await insertMembership(database.pool, {
          id: actor,
          homeId,
          userId,
          role: 'ROOMMATE',
        });
        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await repository.insertEntryWithAudience(tx, {
            entry: entryInput(
              openOld,
              homeId,
              actor,
              'HOUSEHOLD',
              'Open old',
              T1,
            ),
            audienceMembershipIds: [],
          });
          await repository.insertEntryWithAudience(tx, {
            entry: entryInput(
              openNew,
              homeId,
              actor,
              'HOUSEHOLD',
              'Open new',
              T3,
            ),
            audienceMembershipIds: [],
          });
          await repository.insertEntryWithAudience(tx, {
            entry: {
              ...entryInput(
                openTieHigh,
                homeId,
                actor,
                'HOUSEHOLD',
                'Tie high',
                T2,
              ),
            },
            audienceMembershipIds: [],
          });
          await repository.insertEntryWithAudience(tx, {
            entry: entryInput(
              openTieLow,
              homeId,
              actor,
              'HOUSEHOLD',
              'Tie low',
              T2,
            ),
            audienceMembershipIds: [],
          });
          await repository.insertEntryWithAudience(tx, {
            entry: {
              ...entryInput(
                resolved,
                homeId,
                actor,
                'HOUSEHOLD',
                'Resolved later',
                T3,
              ),
              status: 'RESOLVED',
              resolvedByMembershipId: actor,
              resolvedAt: T3,
              updatedAt: T3,
            },
            audienceMembershipIds: [],
          });
        });

        const page = await repository.listVisibleByHome({
          homeId,
          actorMembershipId: actor,
          limit: 10,
        });
        assert.deepEqual(
          page?.items.map((item) => item.id),
          [openNew, openTieHigh, openTieLow, openOld, resolved],
        );

        const openOnly = await repository.listVisibleByHome({
          homeId,
          actorMembershipId: actor,
          limit: 10,
          status: 'OPEN',
        });
        assert.deepEqual(
          openOnly?.items.map((item) => item.id),
          [openNew, openTieHigh, openTieLow, openOld],
        );

        const first = await repository.listVisibleByHome({
          homeId,
          actorMembershipId: actor,
          limit: 2,
        });
        assert.equal(first?.hasMore, true);
        const second = await repository.listVisibleByHome({
          homeId,
          actorMembershipId: actor,
          limit: 2,
          cursor: first?.nextCursor ?? undefined,
        });
        const third = await repository.listVisibleByHome({
          homeId,
          actorMembershipId: actor,
          limit: 2,
          cursor: second?.nextCursor ?? undefined,
        });
        const paged = [
          ...(first?.items ?? []),
          ...(second?.items ?? []),
          ...(third?.items ?? []),
        ].map((item) => item.id);
        assert.deepEqual(paged, [
          openNew,
          openTieHigh,
          openTieLow,
          openOld,
          resolved,
        ]);
        assert.equal(new Set(paged).size, 5);
        assert.equal(third?.hasMore, false);

        const now = new Date('2026-09-13T16:00:00.000Z');
        const updated = await runInReadCommittedTransaction(
          database.pool,
          async (tx) =>
            repository.resolveOpenEntry(tx, {
              homeId,
              maintenanceEntryId: openOld,
              resolverMembershipId: actor,
              resolvedAt: now,
            }),
        );
        assert.equal(updated?.status, 'RESOLVED');
        assert.equal(updated?.resolvedByMembershipId, actor);
        assert.equal(updated?.resolvedAt?.toISOString(), now.toISOString());
        const again = await runInReadCommittedTransaction(
          database.pool,
          async (tx) =>
            repository.resolveOpenEntry(tx, {
              homeId,
              maintenanceEntryId: openOld,
              resolverMembershipId: actor,
              resolvedAt: now,
            }),
        );
        assert.equal(again, null);

        const audience = await database.pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM maintenance_audiences
           WHERE home_id = $1`,
          [homeId],
        );
        assert.equal(audience.rows[0]?.count, '0');
        const outbox = await database.pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM outbox_events
           WHERE home_id = $1 AND event_type LIKE 'maintenance.%'`,
          [homeId],
        );
        assert.equal(outbox.rows[0]?.count, '0');
      } finally {
        await cleanup(database.pool, {
          userIds: [userId],
          homeIds: [homeId],
        });
        await database.close();
      }
    },
  );
});
