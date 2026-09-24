import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createHomePhotoPointerWriter } from '../../domains/homes/photo-pointer.js';
import { createCanonicalHomePhotoObjectKey } from '../../domains/homes/photo-object-key.js';
import { createTempHomePhotoObjectKey } from '../../domains/homes/temp-photo-object-key.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import type { AppConfig } from '../../platform/config/types.js';
import {
  createFakeHomePhotoObjectStore,
  type FakeHomePhotoObjectStore,
} from '../../platform/object-store/index.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import {
  runInReadCommittedTransaction,
} from '../../platform/persistence/transaction.js';
import { createFinalizeHomePhoto } from './finalize-home-photo.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();

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

async function insertUser(pool: Pool, id: string): Promise<void> {
  await pool.query('INSERT INTO users (id, updated_at) VALUES ($1, NOW())', [
    id,
  ]);
}

async function insertHome(pool: Pool, id: string): Promise<void> {
  await pool.query(
    `INSERT INTO homes (id, name, timezone, archived_at, updated_at)
     VALUES ($1, 'Photo Lock Home', 'UTC', NULL, NOW())`,
    [id],
  );
}

async function insertMembership(
  pool: Pool,
  input: { id: string; homeId: string; userId: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO memberships (id, home_id, user_id, role, ended_at, ended_by_membership_id)
     VALUES ($1, $2, $3, 'ROOMMATE', NULL, NULL)`,
    [input.id, input.homeId, input.userId],
  );
}

async function cleanup(
  pool: Pool,
  input: { homeIds: string[]; userIds: string[] },
): Promise<void> {
  if (input.homeIds.length > 0) {
    await pool.query('DELETE FROM outbox_events WHERE home_id = ANY($1)', [
      input.homeIds,
    ]);
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

async function readPointer(pool: Pool, homeId: string): Promise<string | null> {
  const result = await pool.query<{ photo_object_key: string | null }>(
    'SELECT photo_object_key FROM homes WHERE id = $1',
    [homeId],
  );
  return result.rows[0]?.photo_object_key ?? null;
}

async function homeLockAvailable(pool: Pool, homeId: string): Promise<boolean> {
  return runInReadCommittedTransaction(pool, async (tx) => {
    const result = await tx.query(
      'SELECT id FROM homes WHERE id = $1 FOR UPDATE SKIP LOCKED',
      [homeId],
    );
    return result.rows.length === 1;
  });
}

function actor(input: {
  userId: string;
  membershipId: string;
  homeId: string;
}): ActiveHomeActor {
  return { ...input, role: 'ROOMMATE' };
}

function processor() {
  return {
    process: (input: Uint8Array) =>
      Promise.resolve({
        bytes: input,
        width: 32,
        height: 32,
        contentType: 'image/webp' as const,
      }),
  };
}

function delayedProcessor(gate: {
  started: { resolve: () => void };
  release: { promise: Promise<void> };
}) {
  return {
    async process(input: Uint8Array) {
      gate.started.resolve();
      await gate.release.promise;
      return {
        bytes: input,
        width: 32,
        height: 32,
        contentType: 'image/webp' as const,
      };
    },
  };
}

void describe('Home photo finalize concurrency', () => {
  void it(
    'does not hold the Home row lock during GetObject, Sharp, or PutObject',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const databaseUrl = resolveSafeDedicatedTestDatabaseUrl();
      const database = createDatabasePool(testConfig(databaseUrl));
      const userId = randomUUID();
      const homeId = randomUUID();
      const membershipId = randomUUID();
      const uploadId = randomUUID();
      const getStarted = deferred();
      const releaseGet = deferred();
      const processStarted = deferred();
      const releaseProcess = deferred();
      const putStarted = deferred();
      const releasePut = deferred();
      const store = createFakeHomePhotoObjectStore({
        beforeGet: async () => {
          getStarted.resolve();
          await releaseGet.promise;
        },
        beforePut: async () => {
          putStarted.resolve();
          await releasePut.promise;
        },
      });
      store.seed(
        createTempHomePhotoObjectKey(homeId, () => uploadId),
        Buffer.from('temp-bytes'),
      );
      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, homeId);
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
        });
        const finalize = createFinalizeHomePhoto({
          runTransaction: (work) =>
            runInReadCommittedTransaction(database.pool, work),
          pointers: createHomePhotoPointerWriter(),
          objectStore: store,
          imageProcessor: delayedProcessor({
            started: processStarted,
            release: releaseProcess,
          }),
        });
        const pending = finalize({
          actor: actor({ userId, membershipId, homeId }),
          homeId,
          uploadId,
        });
        await getStarted.promise;
        assert.equal(await homeLockAvailable(database.pool, homeId), true);
        releaseGet.resolve();
        await processStarted.promise;
        assert.equal(await homeLockAvailable(database.pool, homeId), true);
        releaseProcess.resolve();
        await putStarted.promise;
        assert.equal(await homeLockAvailable(database.pool, homeId), true);
        releasePut.resolve();
        const home = await pending;
        assert.equal(home.photoObjectKey?.startsWith(`homes/${homeId}/`), true);
        assert.equal(home.photoObjectKey?.startsWith('tmp/'), false);
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
    'rechecks membership under the lock and serializes pointer updates',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const databaseUrl = resolveSafeDedicatedTestDatabaseUrl();
      const database = createDatabasePool(testConfig(databaseUrl));
      const userId = randomUUID();
      const homeId = randomUUID();
      const membershipId = randomUUID();
      const uploadA = randomUUID();
      const uploadB = randomUUID();
      const generationA = randomUUID();
      const generationB = randomUUID();
      const keyOld = createCanonicalHomePhotoObjectKey(homeId);
      const keyA = createCanonicalHomePhotoObjectKey(homeId, () => generationA);
      const keyB = createCanonicalHomePhotoObjectKey(homeId, () => generationB);
      const aMayEnterTx = deferred();
      const aCommitted = deferred();
      const bCommitted = deferred();
      const aMayDeletePrevious = deferred();
      const deleted: string[] = [];
      const inner = createFakeHomePhotoObjectStore();
      inner.seed(keyOld, Buffer.from('old-photo'));
      inner.seed(
        createTempHomePhotoObjectKey(homeId, () => uploadA),
        Buffer.from('a-bytes'),
      );
      inner.seed(
        createTempHomePhotoObjectKey(homeId, () => uploadB),
        Buffer.from('b-bytes'),
      );
      const store: FakeHomePhotoObjectStore = {
        ...inner,
        async deleteObject(input) {
          if (input.key === keyOld) {
            await aMayDeletePrevious.promise;
          }
          deleted.push(input.key);
          return inner.deleteObject(input);
        },
      };
      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, homeId);
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
        });
        await database.pool.query(
          'UPDATE homes SET photo_object_key = $2 WHERE id = $1',
          [homeId, keyOld],
        );
        const currentActor = actor({ userId, membershipId, homeId });
        const finalizeA = createFinalizeHomePhoto({
          runTransaction: async (work) => {
            const result = await runInReadCommittedTransaction(
              database.pool,
              work,
            );
            aCommitted.resolve();
            return result;
          },
          pointers: createHomePhotoPointerWriter(),
          objectStore: store,
          imageProcessor: processor(),
          generateCanonicalKey: () => keyA,
        });
        const finalizeB = createFinalizeHomePhoto({
          runTransaction: async (work) => {
            await aMayEnterTx.promise;
            const result = await runInReadCommittedTransaction(
              database.pool,
              work,
            );
            bCommitted.resolve();
            return result;
          },
          pointers: createHomePhotoPointerWriter(),
          objectStore: store,
          imageProcessor: processor(),
          generateCanonicalKey: () => keyB,
        });

        const pendingA = finalizeA({
          actor: currentActor,
          homeId,
          uploadId: uploadA,
        });
        const pendingB = finalizeB({
          actor: currentActor,
          homeId,
          uploadId: uploadB,
        });
        await aCommitted.promise;
        assert.equal(await readPointer(database.pool, homeId), keyA);
        aMayEnterTx.resolve();
        await bCommitted.promise;
        assert.equal(await readPointer(database.pool, homeId), keyB);
        aMayDeletePrevious.resolve();
        await pendingA;
        await pendingB;
        assert.equal(await readPointer(database.pool, homeId), keyB);
        assert.ok(inner.getStored(keyB));
        assert.equal(inner.getStored(keyA), undefined);
        assert.equal(deleted.includes(keyB), false);
        assert.equal(deleted.includes(keyA), true);
        assert.equal(deleted.includes(keyOld), true);
      } finally {
        aMayEnterTx.resolve();
        aMayDeletePrevious.resolve();
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userId],
        });
        await database.close();
      }
    },
  );

  void it(
    'rechecks membership after processing and conceals when it ended',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const databaseUrl = resolveSafeDedicatedTestDatabaseUrl();
      const database = createDatabasePool(testConfig(databaseUrl));
      const userId = randomUUID();
      const homeId = randomUUID();
      const membershipId = randomUUID();
      const uploadId = randomUUID();
      const previous = createCanonicalHomePhotoObjectKey(homeId);
      const getStarted = deferred();
      const releaseGet = deferred();
      const store = createFakeHomePhotoObjectStore({
        beforeGet: async () => {
          getStarted.resolve();
          await releaseGet.promise;
        },
      });
      store.seed(previous, Buffer.from('old'));
      store.seed(
        createTempHomePhotoObjectKey(homeId, () => uploadId),
        Buffer.from('new-bytes'),
      );
      try {
        await insertUser(database.pool, userId);
        await insertHome(database.pool, homeId);
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId,
        });
        await database.pool.query(
          'UPDATE homes SET photo_object_key = $2 WHERE id = $1',
          [homeId, previous],
        );
        const finalize = createFinalizeHomePhoto({
          runTransaction: (work) =>
            runInReadCommittedTransaction(database.pool, work),
          pointers: createHomePhotoPointerWriter(),
          objectStore: store,
          imageProcessor: processor(),
        });
        const pending = finalize({
          actor: actor({ userId, membershipId, homeId }),
          homeId,
          uploadId,
        });
        await getStarted.promise;
        assert.equal(await homeLockAvailable(database.pool, homeId), true);
        await database.pool.query(
          `UPDATE memberships
           SET ended_at = NOW(), ended_by_membership_id = id
           WHERE id = $1`,
          [membershipId],
        );
        releaseGet.resolve();
        await assert.rejects(pending, ConcealedNotFoundError);
        assert.equal(await readPointer(database.pool, homeId), previous);
        assert.ok(store.getStored(previous));
      } finally {
        releaseGet.resolve();
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userId],
        });
        await database.close();
      }
    },
  );
});
