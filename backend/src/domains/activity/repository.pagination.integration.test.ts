import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import type { AppConfig } from '../../platform/config/types.js';
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import {
  bindActivityListCursor,
  decodeActivityListCursor,
  encodeActivityListCursor,
  ACTIVITY_LIST_QUERY_FINGERPRINT,
} from './cursor.js';
import { InvalidActivityRequestError } from './errors.js';
import { createActivityRepository, type NewActivity } from './repository.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const CREATED = new Date('2026-09-13T12:00:00.000Z');

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

function activityInput(
  id: string,
  homeId: string,
  occurredAt: Date,
  overrides: Partial<NewActivity> = {},
): NewActivity {
  return {
    id,
    homeId,
    sourceOutboxEventId: overrides.sourceOutboxEventId ?? createUuidV7(),
    sourceEntityType: overrides.sourceEntityType ?? 'MAINTENANCE',
    sourceEntityId: overrides.sourceEntityId ?? id,
    eventType: overrides.eventType ?? 'maintenance.created.v1',
    actorMembershipId:
      overrides.actorMembershipId === undefined
        ? null
        : overrides.actorMembershipId,
    occurredAt,
    createdAt: overrides.createdAt ?? CREATED,
  };
}

async function cleanup(
  pool: Pool,
  input: { userIds: string[]; homeIds: string[] },
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
      'DELETE FROM memberships WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
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

async function collectPages(
  list: (cursor?: string) => Promise<{
    items: readonly { id: string; occurredAt: Date }[];
    hasMore: boolean;
    nextCursor: string | null;
  } | null>,
): Promise<{
  ids: string[];
  cursors: Array<string | null>;
  pages: Array<readonly string[]>;
}> {
  const ids: string[] = [];
  const cursors: Array<string | null> = [];
  const pages: Array<readonly string[]> = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i += 1) {
    const page = await list(cursor);
    assert.ok(page);
    const pageIds = page.items.map((item) => item.id);
    pages.push(pageIds);
    ids.push(...pageIds);
    cursors.push(page.nextCursor);
    if (!page.hasMore) {
      assert.equal(page.nextCursor, null);
      break;
    }
    assert.ok(page.nextCursor);
    const last = page.items[page.items.length - 1];
    assert.ok(last);
    const decoded = decodeActivityListCursor(page.nextCursor);
    assert.equal(decoded.id, last.id);
    assert.equal(decoded.occurredAt, last.occurredAt.toISOString());
    cursor = page.nextCursor;
  }
  return { ids, cursors, pages };
}

void describe('Activity repository pagination PostgreSQL', () => {
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
    'pages the private sentinel before cursor, order, and limit',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const repository = createActivityRepository(database.pool);
      const users = [createUuidV7(), createUuidV7(), createUuidV7()] as const;
      const homeA = createUuidV7();
      const homeB = createUuidV7();
      const alex = createUuidV7();
      const jamie = createUuidV7();
      const taylor = createUuidV7();
      const morgan = createUuidV7();
      const H1 = createUuidV7();
      const A1 = createUuidV7();
      const J1 = createUuidV7();
      const H2 = createUuidV7();
      const A2 = createUuidV7();
      const J2 = createUuidV7();
      const H3 = createUuidV7();
      const hidden = Array.from({ length: 30 }, () => createUuidV7());
      const T = (offset: number) =>
        new Date(Date.UTC(2026, 8, 13, 20, 0, 0, offset));
      try {
        await insertUser(database.pool, users[0]);
        await insertUser(database.pool, users[1]);
        await insertUser(database.pool, users[2]);
        await insertHome(database.pool, { id: homeA, name: 'Home A' });
        await insertHome(database.pool, { id: homeB, name: 'Home B' });
        await insertMembership(database.pool, {
          id: alex,
          homeId: homeA,
          userId: users[0],
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: jamie,
          homeId: homeA,
          userId: users[1],
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: taylor,
          homeId: homeA,
          userId: users[2],
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: morgan,
          homeId: homeB,
          userId: users[0],
          role: 'ROOMMATE',
        });

        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await repository.insertHomeVisibleActivity(
            tx,
            activityInput(H1, homeA, T(700), { actorMembershipId: taylor }),
          );
          await repository.insertSourceAuthorizedActivity(
            tx,
            activityInput(A1, homeA, T(600)),
            [alex],
          );
          await repository.insertSourceAuthorizedActivity(
            tx,
            activityInput(J1, homeA, T(500)),
            [jamie],
          );
          await repository.insertHomeVisibleActivity(
            tx,
            activityInput(H2, homeA, T(400), { actorMembershipId: taylor }),
          );
          await repository.insertSourceAuthorizedActivity(
            tx,
            activityInput(A2, homeA, T(300)),
            [alex],
          );
          await repository.insertSourceAuthorizedActivity(
            tx,
            activityInput(J2, homeA, T(200)),
            [jamie],
          );
          await repository.insertHomeVisibleActivity(
            tx,
            activityInput(H3, homeA, T(100), { actorMembershipId: taylor }),
          );
        });

        const list =
          (membershipId: string, homeId = homeA) =>
          (cursor?: string) =>
            repository.listVisiblePageByHome({
              homeId,
              actorMembershipId: membershipId,
              limit: 2,
              ...(cursor !== undefined ? { cursor } : {}),
            });

        const alexPages = await collectPages(list(alex));
        const jamiePages = await collectPages(list(jamie));
        const taylorPages = await collectPages(list(taylor));

        assert.deepEqual(alexPages.ids, [H1, A1, H2, A2, H3]);
        assert.deepEqual(alexPages.pages, [[H1, A1], [H2, A2], [H3]]);
        assert.deepEqual(jamiePages.ids, [H1, J1, H2, J2, H3]);
        assert.deepEqual(jamiePages.pages, [[H1, J1], [H2, J2], [H3]]);
        assert.deepEqual(taylorPages.ids, [H1, H2, H3]);
        assert.deepEqual(taylorPages.pages, [[H1, H2], [H3]]);
        assert.equal(taylorPages.pages[0]?.length, 2);
        const taylorNextCursor = taylorPages.cursors[0];
        assert.ok(taylorNextCursor);
        const taylorCursor = decodeActivityListCursor(taylorNextCursor);
        assert.equal(taylorCursor.id, H2);
        assert.equal(taylorCursor.homeId, homeA);
        assert.equal(taylorCursor.actorMembershipId, taylor);
        assert.equal(new Set(alexPages.ids).size, alexPages.ids.length);
        assert.equal(new Set(taylorPages.ids).size, taylorPages.ids.length);

        await runInReadCommittedTransaction(database.pool, async (tx) => {
          for (const [index, id] of hidden.entries()) {
            await repository.insertSourceAuthorizedActivity(
              tx,
              activityInput(id, homeA, T(690 - index)),
              [jamie],
            );
          }
        });
        const alexAfterHidden = await collectPages(list(alex));
        const taylorAfterHidden = await collectPages(list(taylor));
        assert.deepEqual(alexAfterHidden.ids, [H1, A1, H2, A2, H3]);
        assert.deepEqual(alexAfterHidden.pages, [[H1, A1], [H2, A2], [H3]]);
        assert.deepEqual(taylorAfterHidden.ids, [H1, H2, H3]);
        assert.deepEqual(taylorAfterHidden.pages, [[H1, H2], [H3]]);
        assert.equal(taylorAfterHidden.pages[0]?.length, 2);
        const taylorHiddenCursor = taylorAfterHidden.cursors[0];
        assert.ok(taylorHiddenCursor);
        assert.equal(decodeActivityListCursor(taylorHiddenCursor).id, H2);

        const sameOccurred = new Date('2026-09-13T16:00:00.000Z');
        const lowId = '018f1e2c-7e3a-7000-8000-000000000001';
        const highId = '018f1e2c-7e3a-7000-8000-000000000002';
        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await repository.insertHomeVisibleActivity(
            tx,
            activityInput(lowId, homeA, sameOccurred, {
              actorMembershipId: taylor,
            }),
          );
          await repository.insertHomeVisibleActivity(
            tx,
            activityInput(highId, homeA, sameOccurred, {
              actorMembershipId: taylor,
            }),
          );
        });
        const tied = await repository.listVisiblePageByHome({
          homeId: homeA,
          actorMembershipId: taylor,
          limit: 20,
        });
        assert.ok(tied);
        const tiedIds = tied.items.map((item) => item.id);
        assert.ok(tiedIds.indexOf(highId) < tiedIds.indexOf(lowId));

        assert.equal(
          await repository.listVisiblePageByHome({
            homeId: homeA,
            actorMembershipId: morgan,
            limit: 2,
          }),
          null,
        );

        const homeACursor = taylorPages.cursors[0];
        assert.ok(homeACursor);
        await assert.rejects(
          () =>
            repository.listVisiblePageByHome({
              homeId: homeB,
              actorMembershipId: morgan,
              limit: 2,
              cursor: homeACursor,
            }),
          InvalidActivityRequestError,
        );
        await assert.rejects(
          () =>
            repository.listVisiblePageByHome({
              homeId: homeA,
              actorMembershipId: taylor,
              limit: 2,
              cursor: '%%%',
            }),
          InvalidActivityRequestError,
        );
        const forged = encodeActivityListCursor({
          v: 1,
          occurredAt: '2026-09-13T20:00:00.700Z',
          id: H1,
          homeId: homeB,
          actorMembershipId: taylor,
          queryFingerprint: ACTIVITY_LIST_QUERY_FINGERPRINT,
        });
        await assert.rejects(
          () =>
            repository.listVisiblePageByHome({
              homeId: homeA,
              actorMembershipId: taylor,
              limit: 2,
              cursor: forged,
            }),
          InvalidActivityRequestError,
        );
        assert.throws(
          () =>
            bindActivityListCursor(homeACursor, {
              homeId: homeB,
              actorMembershipId: morgan,
              queryFingerprint: ACTIVITY_LIST_QUERY_FINGERPRINT,
            }),
          InvalidActivityRequestError,
        );
      } finally {
        await cleanup(database.pool, {
          userIds: [...users],
          homeIds: [homeA, homeB],
        });
        await database.close();
      }
    },
  );

  void it(
    'keeps rejoin from inheriting prior SOURCE_AUTHORIZED pages',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const repository = createActivityRepository(database.pool);
      const userId = createUuidV7();
      const otherUser = createUuidV7();
      const homeId = createUuidV7();
      const membershipA = createUuidV7();
      const membershipB = createUuidV7();
      const roommate = createUuidV7();
      const homeVisible = createUuidV7();
      const privateA = createUuidV7();
      try {
        await insertUser(database.pool, userId);
        await insertUser(database.pool, otherUser);
        await insertHome(database.pool, { id: homeId, name: 'Rejoin' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId,
          role: 'ROOMMATE',
          ended: true,
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId,
          userId,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: roommate,
          homeId,
          userId: otherUser,
          role: 'ROOMMATE',
        });
        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await repository.insertHomeVisibleActivity(
            tx,
            activityInput(
              homeVisible,
              homeId,
              new Date('2026-09-13T18:00:00.000Z'),
              {
                actorMembershipId: roommate,
              },
            ),
          );
          await repository.insertSourceAuthorizedActivity(
            tx,
            activityInput(
              privateA,
              homeId,
              new Date('2026-09-13T17:00:00.000Z'),
            ),
            [membershipA],
          );
        });

        assert.equal(
          await repository.listVisiblePageByHome({
            homeId,
            actorMembershipId: membershipA,
            limit: 10,
          }),
          null,
        );
        const rejoined = await repository.listVisiblePageByHome({
          homeId,
          actorMembershipId: membershipB,
          limit: 10,
        });
        assert.ok(rejoined);
        assert.deepEqual(
          rejoined.items.map((item) => item.id),
          [homeVisible],
        );
        assert.equal(rejoined.hasMore, false);
        assert.equal(rejoined.nextCursor, null);
      } finally {
        await cleanup(database.pool, {
          userIds: [userId, otherUser],
          homeIds: [homeId],
        });
        await database.close();
      }
    },
  );
});
