import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  AuthorizationIntegrityError,
  ConcealedNotFoundError,
} from '../../platform/authz/errors.js';
import { StructuralIntegrityError } from './structure-errors.js';
import type { AppConfig } from '../../platform/config/types.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import { resolveTestDatabaseUrl } from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import { lockHomeStructure } from './lock-home-structure.js';

const skipWithoutDatabase =
  !process.env['TEST_DATABASE_URL'] && !process.env['DATABASE_URL']
    ? 'requires a migrated PostgreSQL test database'
    : false;

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
  throw new Error('timed out waiting for structural lock wait');
}

async function isWaitingForLock(pool: Pool, pid: number): Promise<boolean> {
  const result = await pool.query<{ wait_event_type: string | null }>(
    'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
    [pid],
  );
  return result.rows[0]?.wait_event_type === 'Lock';
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

function actor(input: {
  userId: string;
  membershipId: string;
  homeId: string;
  role: ActiveHomeActor['role'];
}): ActiveHomeActor {
  return { ...input };
}

void describe('lockHomeStructure PostgreSQL', () => {
  void it(
    'serializes same-Home structural locks and lets B read post-commit state',
    { skip: skipWithoutDatabase, timeout: 20_000 },
    async () => {
      const database = createDatabasePool(testConfig(resolveTestDatabaseUrl()));
      const userA = randomUUID();
      const userB = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const membershipB = randomUUID();
      const aLocked = deferred();
      const aMayFinish = deferred();
      const bPid = deferred<number>();
      let bFinished = false;

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeId, name: 'Mutex Home' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ADMIN',
        });

        const aRun = runInReadCommittedTransaction(
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
            aLocked.resolve();
            await aMayFinish.promise;
            await tx.query(
              `INSERT INTO memberships (id, home_id, user_id, role)
             VALUES ($1, $2, $3, 'ROOMMATE')`,
              [membershipB, homeId, userB],
            );
            return locked;
          },
        );

        await aLocked.promise;

        const bRun = runInReadCommittedTransaction(
          database.pool,
          async (tx) => {
            const pid = await tx.query<{ pid: number | string }>(
              'SELECT pg_backend_pid() AS pid',
            );
            const row = pid.rows[0];
            if (row === undefined) {
              throw new Error('backend pid was missing');
            }
            bPid.resolve(Number(row.pid));
            const locked = await lockHomeStructure(tx, {
              homeId,
              actor: actor({
                userId: userA,
                membershipId: membershipA,
                homeId,
                role: 'ADMIN',
              }),
            });
            bFinished = true;
            return locked;
          },
        );

        const pid = await bPid.promise;
        await waitUntil(() => isWaitingForLock(database.pool, pid));
        assert.equal(bFinished, false);

        aMayFinish.resolve();
        const [, bLocked] = await Promise.all([aRun, bRun]);
        assert.equal(bFinished, true);
        assert.equal(bLocked.activeMemberships.length, 2);
        assert.ok(
          bLocked.activeMemberships.some(
            (membership) => membership.id === membershipB,
          ),
        );
      } finally {
        await database.pool.query(
          'DELETE FROM memberships WHERE id = ANY($1)',
          [[membershipA, membershipB]],
        );
        await database.pool.query('DELETE FROM homes WHERE id = $1', [homeId]);
        await database.pool.query('DELETE FROM users WHERE id = ANY($1)', [
          [userA, userB],
        ]);
        await database.close();
      }
    },
  );

  void it(
    'does not block unrelated Homes',
    { skip: skipWithoutDatabase, timeout: 15_000 },
    async () => {
      const database = createDatabasePool(testConfig(resolveTestDatabaseUrl()));
      const userA = randomUUID();
      const userB = randomUUID();
      const homeA = randomUUID();
      const homeB = randomUUID();
      const membershipA = randomUUID();
      const membershipB = randomUUID();
      const aReady = deferred();
      const bReady = deferred();
      const release = deferred();

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeA, name: 'Home A' });
        await insertHome(database.pool, { id: homeB, name: 'Home B' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId: homeA,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId: homeB,
          userId: userB,
          role: 'ADMIN',
        });

        const aRun = runInReadCommittedTransaction(
          database.pool,
          async (tx) => {
            const locked = await lockHomeStructure(tx, {
              homeId: homeA,
              actor: actor({
                userId: userA,
                membershipId: membershipA,
                homeId: homeA,
                role: 'ADMIN',
              }),
            });
            aReady.resolve();
            await release.promise;
            return locked;
          },
        );
        const bRun = runInReadCommittedTransaction(
          database.pool,
          async (tx) => {
            const locked = await lockHomeStructure(tx, {
              homeId: homeB,
              actor: actor({
                userId: userB,
                membershipId: membershipB,
                homeId: homeB,
                role: 'ADMIN',
              }),
            });
            bReady.resolve();
            await release.promise;
            return locked;
          },
        );

        await Promise.race([
          Promise.all([aReady.promise, bReady.promise]),
          new Promise<never>((_, reject) => {
            setTimeout(() => {
              reject(new Error('unrelated Homes blocked each other'));
            }, 8_000);
          }),
        ]);

        release.resolve();
        const [lockedA, lockedB] = await Promise.all([aRun, bRun]);
        assert.equal(lockedA.home.id, homeA);
        assert.equal(lockedB.home.id, homeB);
      } finally {
        release.resolve();
        await database.pool.query(
          'DELETE FROM memberships WHERE id = ANY($1)',
          [[membershipA, membershipB]],
        );
        await database.pool.query('DELETE FROM homes WHERE id = ANY($1)', [
          [homeA, homeB],
        ]);
        await database.pool.query('DELETE FROM users WHERE id = ANY($1)', [
          [userA, userB],
        ]);
        await database.close();
      }
    },
  );

  void it(
    'rebuilds a stale middleware ADMIN role from locked ROOMMATE state',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(testConfig(resolveTestDatabaseUrl()));
      const userA = randomUUID();
      const userB = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const membershipB = randomUUID();

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeId, name: 'Stale Role' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ROOMMATE',
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId,
          userId: userB,
          role: 'ADMIN',
        });

        const locked = await runInReadCommittedTransaction(
          database.pool,
          (tx) =>
            lockHomeStructure(tx, {
              homeId,
              actor: actor({
                userId: userA,
                membershipId: membershipA,
                homeId,
                role: 'ADMIN',
              }),
            }),
        );

        assert.equal(locked.actor.role, 'ROOMMATE');
        assert.equal(locked.actor.membershipId, membershipA);
      } finally {
        await database.pool.query(
          'DELETE FROM memberships WHERE id = ANY($1)',
          [[membershipA, membershipB]],
        );
        await database.pool.query('DELETE FROM homes WHERE id = $1', [homeId]);
        await database.pool.query('DELETE FROM users WHERE id = ANY($1)', [
          [userA, userB],
        ]);
        await database.close();
      }
    },
  );

  void it(
    'rebuilds a stale middleware ROOMMATE role from locked ADMIN state',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(testConfig(resolveTestDatabaseUrl()));
      const userId = randomUUID();
      const homeId = randomUUID();
      const membershipId = randomUUID();

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, { id: homeId, name: 'Fresh Admin' });
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ADMIN',
        });

        const locked = await runInReadCommittedTransaction(
          database.pool,
          (tx) =>
            lockHomeStructure(tx, {
              homeId,
              actor: actor({
                userId,
                membershipId,
                homeId,
                role: 'ROOMMATE',
              }),
            }),
        );

        assert.equal(locked.actor.role, 'ADMIN');
      } finally {
        await database.pool.query('DELETE FROM memberships WHERE id = $1', [
          membershipId,
        ]);
        await database.pool.query('DELETE FROM homes WHERE id = $1', [homeId]);
        await database.pool.query('DELETE FROM users WHERE id = $1', [userId]);
        await database.close();
      }
    },
  );

  void it(
    'preserves membership tenure across leave-and-rejoin',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(testConfig(resolveTestDatabaseUrl()));
      const userId = randomUUID();
      const homeId = randomUUID();
      const oldMembershipId = randomUUID();
      const newMembershipId = randomUUID();

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, { id: homeId, name: 'Rejoin' });
        await insertMembership(database.pool, {
          id: oldMembershipId,
          homeId,
          userId,
          role: 'ROOMMATE',
        });
        await database.pool.query(
          'UPDATE memberships SET ended_at = NOW() WHERE id = $1',
          [oldMembershipId],
        );
        await insertMembership(database.pool, {
          id: newMembershipId,
          homeId,
          userId,
          role: 'ADMIN',
        });

        await assert.rejects(
          () =>
            runInReadCommittedTransaction(database.pool, (tx) =>
              lockHomeStructure(tx, {
                homeId,
                actor: actor({
                  userId,
                  membershipId: oldMembershipId,
                  homeId,
                  role: 'ADMIN',
                }),
              }),
            ),
          ConcealedNotFoundError,
        );

        const locked = await runInReadCommittedTransaction(
          database.pool,
          (tx) =>
            lockHomeStructure(tx, {
              homeId,
              actor: actor({
                userId,
                membershipId: newMembershipId,
                homeId,
                role: 'ROOMMATE',
              }),
            }),
        );
        assert.equal(locked.actor.membershipId, newMembershipId);
        assert.equal(locked.actor.role, 'ADMIN');
      } finally {
        await database.pool.query(
          'DELETE FROM memberships WHERE id = ANY($1)',
          [[oldMembershipId, newMembershipId]],
        );
        await database.pool.query('DELETE FROM homes WHERE id = $1', [homeId]);
        await database.pool.query('DELETE FROM users WHERE id = $1', [userId]);
        await database.close();
      }
    },
  );

  void it(
    'conceals a cross-Home lock attempt as NOT_FOUND',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(testConfig(resolveTestDatabaseUrl()));
      const userA = randomUUID();
      const userB = randomUUID();
      const homeA = randomUUID();
      const homeB = randomUUID();
      const membershipA = randomUUID();
      const membershipB = randomUUID();

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeA, name: 'A' });
        await insertHome(database.pool, { id: homeB, name: 'B' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId: homeA,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId: homeB,
          userId: userB,
          role: 'ADMIN',
        });

        await assert.rejects(
          () =>
            runInReadCommittedTransaction(database.pool, (tx) =>
              lockHomeStructure(tx, {
                homeId: homeB,
                actor: actor({
                  userId: userA,
                  membershipId: membershipA,
                  homeId: homeA,
                  role: 'ADMIN',
                }),
              }),
            ),
          ConcealedNotFoundError,
        );
      } finally {
        await database.pool.query(
          'DELETE FROM memberships WHERE id = ANY($1)',
          [[membershipA, membershipB]],
        );
        await database.pool.query('DELETE FROM homes WHERE id = ANY($1)', [
          [homeA, homeB],
        ]);
        await database.pool.query('DELETE FROM users WHERE id = ANY($1)', [
          [userA, userB],
        ]);
        await database.close();
      }
    },
  );

  void it(
    'conceals an archived Home as NOT_FOUND',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(testConfig(resolveTestDatabaseUrl()));
      const userId = randomUUID();
      const homeId = randomUUID();
      const membershipId = randomUUID();

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, {
          id: homeId,
          name: 'Archived',
          archived: true,
        });
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ADMIN',
        });

        await assert.rejects(
          () =>
            runInReadCommittedTransaction(database.pool, (tx) =>
              lockHomeStructure(tx, {
                homeId,
                actor: actor({
                  userId,
                  membershipId,
                  homeId,
                  role: 'ADMIN',
                }),
              }),
            ),
          ConcealedNotFoundError,
        );
      } finally {
        await database.pool.query('DELETE FROM memberships WHERE id = $1', [
          membershipId,
        ]);
        await database.pool.query('DELETE FROM homes WHERE id = $1', [homeId]);
        await database.pool.query('DELETE FROM users WHERE id = $1', [userId]);
        await database.close();
      }
    },
  );

  void it(
    'fails closed on zero-admin active state without repair',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(testConfig(resolveTestDatabaseUrl()));
      const userId = randomUUID();
      const homeId = randomUUID();
      const membershipId = randomUUID();

      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, { id: homeId, name: 'Corrupt' });
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
          role: 'ROOMMATE',
        });

        await assert.rejects(
          () =>
            runInReadCommittedTransaction(database.pool, (tx) =>
              lockHomeStructure(tx, {
                homeId,
                actor: actor({
                  userId,
                  membershipId,
                  homeId,
                  role: 'ROOMMATE',
                }),
              }),
            ),
          (error: unknown) => {
            assert.ok(error instanceof StructuralIntegrityError);
            assert.equal(error instanceof AuthorizationIntegrityError, false);
            return true;
          },
        );

        const home = await database.pool.query<{ archived_at: Date | null }>(
          'SELECT archived_at FROM homes WHERE id = $1',
          [homeId],
        );
        const membership = await database.pool.query<{ role: string }>(
          'SELECT role FROM memberships WHERE id = $1',
          [membershipId],
        );
        assert.equal(home.rows[0]?.archived_at, null);
        assert.equal(membership.rows[0]?.role, 'ROOMMATE');
      } finally {
        await database.pool.query('DELETE FROM memberships WHERE id = $1', [
          membershipId,
        ]);
        await database.pool.query('DELETE FROM homes WHERE id = $1', [homeId]);
        await database.pool.query('DELETE FROM users WHERE id = $1', [userId]);
        await database.close();
      }
    },
  );
});
