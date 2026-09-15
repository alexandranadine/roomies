import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import type { AppConfig } from '../../platform/config/types.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import { resolveTestDatabaseUrl } from '../../platform/persistence/test-database.js';
import {
  runInReadCommittedTransaction,
  type TransactionContext,
} from '../../platform/persistence/transaction.js';
import { createCanonicalUserDeletionMarkerPersistence } from './canonical-user-deletion-marker.js';

const skipWithoutDatabase =
  !process.env['TEST_DATABASE_URL'] && !process.env['DATABASE_URL']
    ? 'requires a migrated PostgreSQL test database'
    : false;

const DELETED_AT = new Date('2026-09-14T21:00:00.000Z');

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
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 8_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 15);
    });
  }
  throw new Error('timed out waiting for canonical user lock wait');
}

async function isWaitingForLock(pool: Pool, pid: number): Promise<boolean> {
  const result = await pool.query<{ wait_event_type: string | null }>(
    'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
    [pid],
  );
  return result.rows[0]?.wait_event_type === 'Lock';
}

async function backendPid(tx: TransactionContext): Promise<number> {
  const result = await tx.query<{ pid: number | string }>(
    'SELECT pg_backend_pid() AS pid',
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('backend pid was missing');
  }
  return Number(row.pid);
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
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO memberships (id, home_id, user_id, role, ended_at, ended_by_membership_id)
     VALUES ($1, $2, $3, $4, NULL, NULL)`,
    [input.id, input.homeId, input.userId, input.role],
  );
}

async function provisionCanonicalUser(
  pool: Pool,
  email: string,
): Promise<string> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO auth_identities (name, email, email_verified)
     VALUES ('Canonical deletion marker', $1, false)
     RETURNING id::text AS id`,
    [email],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) {
    throw new Error('provisioned auth identity id was missing');
  }
  return id;
}

async function insertAuthAccount(pool: Pool, userId: string): Promise<string> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO auth_accounts (account_id, provider_id, user_id, password)
     VALUES ($1, 'credential', $2::uuid, 'deletion-marker-hash')
     RETURNING id::text AS id`,
    [userId, userId],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) {
    throw new Error('auth account id was missing');
  }
  return id;
}

async function insertAuthSession(
  pool: Pool,
  userId: string,
  token: string,
): Promise<string> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO auth_sessions (expires_at, token, ip_address, user_agent, user_id)
     VALUES (NOW() + INTERVAL '1 hour', $1, '127.0.0.1', 'deletion-marker-test', $2::uuid)
     RETURNING id::text AS id`,
    [token, userId],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) {
    throw new Error('auth session id was missing');
  }
  return id;
}

async function userDeletedAt(
  pool: Pool,
  userId: string,
): Promise<Date | null | undefined> {
  const result = await pool.query<{ deleted_at: Date | null }>(
    'SELECT deleted_at FROM users WHERE id = $1',
    [userId],
  );
  return result.rows[0]?.deleted_at;
}

async function cleanup(
  pool: Pool,
  input: {
    userIds: string[];
    homeIds?: string[];
    membershipIds?: string[];
  },
): Promise<void> {
  if ((input.membershipIds?.length ?? 0) > 0) {
    await pool.query('DELETE FROM memberships WHERE id = ANY($1::uuid[])', [
      input.membershipIds,
    ]);
  }
  if ((input.homeIds?.length ?? 0) > 0) {
    await pool.query('DELETE FROM homes WHERE id = ANY($1::uuid[])', [
      input.homeIds,
    ]);
  }
  if (input.userIds.length > 0) {
    await pool.query('DELETE FROM auth_identities WHERE id = ANY($1::uuid[])', [
      input.userIds,
    ]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
      input.userIds,
    ]);
  }
}

void describe('canonical User deletion marker PostgreSQL', () => {
  void it(
    'leaves existing User rows with deletedAt NULL after migration',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(testConfig(resolveTestDatabaseUrl()));
      const userId = randomUUID();

      try {
        await insertUser(database.pool, userId);
        assert.equal(await userDeletedAt(database.pool, userId), null);
      } finally {
        await cleanup(database.pool, { userIds: [userId] });
        await database.close();
      }
    },
  );

  void it(
    'provisions a brand-new canonical User with deletedAt NULL',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(testConfig(resolveTestDatabaseUrl()));
      const email = `m81-provision-${randomUUID()}@roomies.test`;
      let userId: string | undefined;

      try {
        userId = await provisionCanonicalUser(database.pool, email);
        const row = await database.pool.query<{
          id: string;
          deleted_at: Date | null;
        }>('SELECT id, deleted_at FROM users WHERE id = $1', [userId]);
        assert.equal(row.rows[0]?.id, userId);
        assert.equal(row.rows[0]?.deleted_at, null);
      } finally {
        await cleanup(database.pool, { userIds: userId ? [userId] : [] });
        await database.close();
      }
    },
  );

  void it(
    'selects and locks a canonical User by UUID in a caller transaction',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(testConfig(resolveTestDatabaseUrl()));
      const userId = randomUUID();
      const persistence = createCanonicalUserDeletionMarkerPersistence();

      try {
        await insertUser(database.pool, userId);
        const locked = await runInReadCommittedTransaction(
          database.pool,
          (tx) => persistence.lockByUserId(tx, userId),
        );
        assert.deepEqual(locked, { userId, deletedAt: null });
      } finally {
        await cleanup(database.pool, { userIds: [userId] });
        await database.close();
      }
    },
  );

  void it(
    'sets deletedAt transactionally from the caller-provided timestamp',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(testConfig(resolveTestDatabaseUrl()));
      const userId = randomUUID();
      const persistence = createCanonicalUserDeletionMarkerPersistence();

      try {
        await insertUser(database.pool, userId);
        const marked = await runInReadCommittedTransaction(
          database.pool,
          async (tx) => {
            const locked = await persistence.lockByUserId(tx, userId);
            assert.equal(locked?.deletedAt, null);
            const rowCount = await persistence.markDeleted(tx, {
              userId,
              deletedAt: DELETED_AT,
            });
            const after = await persistence.lockByUserId(tx, userId);
            return { rowCount, after };
          },
        );

        assert.equal(marked.rowCount, 1);
        assert.equal(marked.after?.userId, userId);
        assert.equal(marked.after?.deletedAt?.getTime(), DELETED_AT.getTime());
        assert.equal(
          (await userDeletedAt(database.pool, userId))?.getTime(),
          DELETED_AT.getTime(),
        );
      } finally {
        await cleanup(database.pool, { userIds: [userId] });
        await database.close();
      }
    },
  );

  void it(
    'restores deletedAt NULL when the caller transaction rolls back',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(testConfig(resolveTestDatabaseUrl()));
      const userId = randomUUID();
      const persistence = createCanonicalUserDeletionMarkerPersistence();

      try {
        await insertUser(database.pool, userId);
        await assert.rejects(
          () =>
            runInReadCommittedTransaction(database.pool, async (tx) => {
              await persistence.lockByUserId(tx, userId);
              await persistence.markDeleted(tx, {
                userId,
                deletedAt: DELETED_AT,
              });
              const locked = await persistence.lockByUserId(tx, userId);
              assert.equal(locked?.deletedAt?.getTime(), DELETED_AT.getTime());
              throw new Error('rollback-deletion-marker');
            }),
          /rollback-deletion-marker/,
        );
        assert.equal(await userDeletedAt(database.pool, userId), null);
      } finally {
        await cleanup(database.pool, { userIds: [userId] });
        await database.close();
      }
    },
  );

  void it(
    'keeps the historical Membership FK valid after deletedAt is set',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(testConfig(resolveTestDatabaseUrl()));
      const userId = randomUUID();
      const homeId = randomUUID();
      const membershipId = randomUUID();
      const persistence = createCanonicalUserDeletionMarkerPersistence();

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, homeId, 'Historical tenure');
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ROOMMATE',
        });

        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await persistence.lockByUserId(tx, userId);
          assert.equal(
            await persistence.markDeleted(tx, {
              userId,
              deletedAt: DELETED_AT,
            }),
            1,
          );
        });

        const membership = await database.pool.query<{
          id: string;
          user_id: string;
          ended_at: Date | null;
        }>('SELECT id, user_id, ended_at FROM memberships WHERE id = $1', [
          membershipId,
        ]);
        assert.equal(membership.rows[0]?.id, membershipId);
        assert.equal(membership.rows[0]?.user_id, userId);
        assert.equal(membership.rows[0]?.ended_at, null);
        assert.equal(
          (await userDeletedAt(database.pool, userId))?.getTime(),
          DELETED_AT.getTime(),
        );
      } finally {
        await cleanup(database.pool, {
          userIds: [userId],
          homeIds: [homeId],
          membershipIds: [membershipId],
        });
        await database.close();
      }
    },
  );

  void it(
    'does not delete User, Membership, AuthIdentity, AuthAccount, or AuthSession',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(testConfig(resolveTestDatabaseUrl()));
      const homeId = randomUUID();
      const membershipId = randomUUID();
      const persistence = createCanonicalUserDeletionMarkerPersistence();
      let userId: string | undefined;

      try {
        const provisionedId = await provisionCanonicalUser(
          database.pool,
          `m81-retain-${randomUUID()}@roomies.test`,
        );
        userId = provisionedId;
        await insertAuthAccount(database.pool, provisionedId);
        await insertAuthSession(
          database.pool,
          provisionedId,
          `m81-session-${randomUUID()}`,
        );
        await insertHome(database.pool, homeId, 'Retention home');
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId: provisionedId,
          role: 'ADMIN',
        });

        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await persistence.lockByUserId(tx, provisionedId);
          assert.equal(
            await persistence.markDeleted(tx, {
              userId: provisionedId,
              deletedAt: DELETED_AT,
            }),
            1,
          );
        });

        const counts = await database.pool.query<{
          users: string;
          memberships: string;
          identities: string;
          accounts: string;
          sessions: string;
        }>(
          `SELECT
             (SELECT COUNT(*)::text FROM users WHERE id = $1::uuid) AS users,
             (SELECT COUNT(*)::text FROM memberships WHERE id = $2::uuid) AS memberships,
             (SELECT COUNT(*)::text FROM auth_identities WHERE id = $1::uuid) AS identities,
             (SELECT COUNT(*)::text FROM auth_accounts WHERE user_id = $1::uuid) AS accounts,
             (SELECT COUNT(*)::text FROM auth_sessions WHERE user_id = $1::uuid) AS sessions`,
          [userId, membershipId],
        );
        assert.equal(counts.rows[0]?.users, '1');
        assert.equal(counts.rows[0]?.memberships, '1');
        assert.equal(counts.rows[0]?.identities, '1');
        assert.equal(counts.rows[0]?.accounts, '1');
        assert.equal(counts.rows[0]?.sessions, '1');
      } finally {
        await cleanup(database.pool, {
          userIds: userId ? [userId] : [],
          homeIds: [homeId],
          membershipIds: [membershipId],
        });
        await database.close();
      }
    },
  );

  void it(
    'serializes two lifecycle-style callers locking the same User',
    { skip: skipWithoutDatabase, timeout: 20_000 },
    async () => {
      const database = createDatabasePool(testConfig(resolveTestDatabaseUrl()));
      const userId = randomUUID();
      const persistence = createCanonicalUserDeletionMarkerPersistence();
      const aLocked = deferred();
      const aMayFinish = deferred();
      const bPid = deferred<number>();
      let bFinished = false;

      try {
        await insertUser(database.pool, userId);

        const aRun = runInReadCommittedTransaction(
          database.pool,
          async (tx) => {
            const locked = await persistence.lockByUserId(tx, userId);
            aLocked.resolve();
            await aMayFinish.promise;
            const rowCount = await persistence.markDeleted(tx, {
              userId,
              deletedAt: DELETED_AT,
            });
            return { locked, rowCount };
          },
        );

        await aLocked.promise;

        const bRun = runInReadCommittedTransaction(
          database.pool,
          async (tx) => {
            bPid.resolve(await backendPid(tx));
            const locked = await persistence.lockByUserId(tx, userId);
            bFinished = true;
            return locked;
          },
        );

        const pid = await bPid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));
        assert.equal(bFinished, false);

        aMayFinish.resolve();
        const [aResult, bLocked] = await Promise.all([aRun, bRun]);
        assert.equal(aResult.rowCount, 1);
        assert.equal(aResult.locked?.deletedAt, null);
        assert.equal(bFinished, true);
        assert.equal(bLocked?.userId, userId);
        assert.equal(bLocked?.deletedAt?.getTime(), DELETED_AT.getTime());
      } finally {
        aMayFinish.resolve();
        await cleanup(database.pool, { userIds: [userId] });
        await database.close();
      }
    },
  );

  void it(
    'does not serialize lifecycle-style callers on different Users',
    { skip: skipWithoutDatabase, timeout: 15_000 },
    async () => {
      const database = createDatabasePool(testConfig(resolveTestDatabaseUrl()));
      const userA = randomUUID();
      const userB = randomUUID();
      const persistence = createCanonicalUserDeletionMarkerPersistence();
      const aReady = deferred();
      const bReady = deferred();
      const release = deferred();

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);

        const aRun = runInReadCommittedTransaction(
          database.pool,
          async (tx) => {
            const locked = await persistence.lockByUserId(tx, userA);
            aReady.resolve();
            await release.promise;
            return locked;
          },
        );
        const bRun = runInReadCommittedTransaction(
          database.pool,
          async (tx) => {
            const locked = await persistence.lockByUserId(tx, userB);
            bReady.resolve();
            await release.promise;
            return locked;
          },
        );

        await Promise.race([
          Promise.all([aReady.promise, bReady.promise]),
          new Promise<never>((_, reject) => {
            setTimeout(() => {
              reject(new Error('unrelated Users blocked each other'));
            }, 8_000);
          }),
        ]);

        release.resolve();
        const [lockedA, lockedB] = await Promise.all([aRun, bRun]);
        assert.deepEqual(lockedA, { userId: userA, deletedAt: null });
        assert.deepEqual(lockedB, { userId: userB, deletedAt: null });
      } finally {
        release.resolve();
        await cleanup(database.pool, { userIds: [userA, userB] });
        await database.close();
      }
    },
  );
});
