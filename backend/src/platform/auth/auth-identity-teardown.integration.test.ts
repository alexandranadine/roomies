import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { normalizeEmail } from '../../../auth-runtime/src/index.js';
import type { AppConfig } from '../config/types.js';
import { createDatabasePool } from '../persistence/pool.js';
import { resolveTestDatabaseUrl } from '../persistence/test-database.js';
import { runInReadCommittedTransaction } from '../persistence/transaction.js';
import {
  authLifecycleIdentityFromCurrent,
  createAuthIdentityTeardownPersistence,
} from './auth-identity-teardown.js';
import { findCurrentCanonicalIdentityByUser } from './canonical-identity-by-user.js';
import { AuthInfrastructureError } from './errors.js';

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

type Queryable = {
  query<T>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
};

type AuthRowCounts = {
  identities: string;
  accounts: string;
  sessions: string;
  verifications: string;
  users: string;
  memberships: string;
};

async function counts(
  database: Queryable,
  userId: string,
): Promise<AuthRowCounts> {
  const result = await database.query<AuthRowCounts>(
    `SELECT
       (SELECT count(*)::text FROM auth_identities WHERE id = $1::uuid) AS identities,
       (SELECT count(*)::text FROM auth_accounts WHERE user_id = $1::uuid) AS accounts,
       (SELECT count(*)::text FROM auth_sessions WHERE user_id = $1::uuid) AS sessions,
       (SELECT count(*)::text FROM auth_verifications WHERE value = $1::text OR identifier = (
         SELECT email FROM auth_identities WHERE id = $1::uuid
       )) AS verifications,
       (SELECT count(*)::text FROM users WHERE id = $1::uuid) AS users,
       (SELECT count(*)::text FROM memberships WHERE user_id = $1::uuid) AS memberships`,
    [userId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('count row was missing');
  }
  return row;
}

async function verificationCountByValue(
  database: Queryable,
  value: string,
): Promise<number> {
  const result = await database.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM auth_verifications WHERE value = $1',
    [value],
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function verificationCountByIdentifier(
  database: Queryable,
  identifier: string,
): Promise<number> {
  const result = await database.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM auth_verifications WHERE identifier = $1',
    [identifier],
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function provisionCanonicalUser(
  pool: Pool,
  email: string,
): Promise<string> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO auth_identities (name, email, email_verified)
     VALUES ('Auth teardown', $1, false)
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
     VALUES ($1, 'credential', $2::uuid, 'teardown-hash')
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
     VALUES (NOW() + INTERVAL '1 hour', $1, '127.0.0.1', 'teardown-test', $2::uuid)
     RETURNING id::text AS id`,
    [token, userId],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) {
    throw new Error('auth session id was missing');
  }
  return id;
}

async function insertVerification(
  pool: Pool,
  input: { identifier: string; value: string },
): Promise<string> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO auth_verifications (identifier, value, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '1 hour')
     RETURNING id::text AS id`,
    [input.identifier, input.value],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) {
    throw new Error('auth verification id was missing');
  }
  return id;
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
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO memberships (id, home_id, user_id, role, ended_at, ended_by_membership_id)
     VALUES ($1, $2, $3, 'ROOMMATE', NULL, NULL)`,
    [input.id, input.homeId, input.userId],
  );
}

async function fkDeleteAction(pool: Pool, constraint: string): Promise<string> {
  const result = await pool.query<{ confdeltype: string }>(
    `SELECT c.confdeltype
     FROM pg_catalog.pg_constraint AS c
     WHERE c.conname = $1`,
    [constraint],
  );
  const action = result.rows[0]?.confdeltype;
  if (action === undefined) {
    throw new Error('fk delete action was missing');
  }
  return action;
}

async function cleanup(
  pool: Pool,
  input: {
    userIds: string[];
    homeIds?: string[];
    membershipIds?: string[];
    verificationIds?: string[];
  },
): Promise<void> {
  if ((input.verificationIds?.length ?? 0) > 0) {
    await pool.query(
      'DELETE FROM auth_verifications WHERE id = ANY($1::uuid[])',
      [input.verificationIds],
    );
  }
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

void describe('auth identity teardown PostgreSQL', () => {
  void it(
    'tears down attributable auth rows inside a caller transaction without deleting User or Membership',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(testConfig(resolveTestDatabaseUrl()));
      const persistence = createAuthIdentityTeardownPersistence();
      const targetEmail = normalizeEmail(
        `m85-target-${randomUUID()}@roomies.test`,
      );
      const otherEmail = normalizeEmail(
        `m85-other-${randomUUID()}@roomies.test`,
      );
      const homeId = randomUUID();
      const membershipId = randomUUID();
      const otherMembershipId = randomUUID();
      const otherHomeId = randomUUID();
      let targetId: string | undefined;
      let otherId: string | undefined;
      const verificationIds: string[] = [];

      try {
        assert.equal(
          await fkDeleteAction(database.pool, 'auth_accounts_user_id_fkey'),
          'c',
        );
        assert.equal(
          await fkDeleteAction(database.pool, 'auth_sessions_user_id_fkey'),
          'c',
        );
        assert.equal(
          await fkDeleteAction(database.pool, 'auth_identities_id_fkey'),
          'r',
        );

        targetId = await provisionCanonicalUser(database.pool, targetEmail);
        otherId = await provisionCanonicalUser(database.pool, otherEmail);
        await insertAuthAccount(database.pool, targetId);
        await insertAuthAccount(database.pool, otherId);
        await insertAuthSession(
          database.pool,
          targetId,
          `target-${randomUUID()}`,
        );
        await insertAuthSession(
          database.pool,
          otherId,
          `other-${randomUUID()}`,
        );
        await insertHome(database.pool, homeId, 'Target home');
        await insertHome(database.pool, otherHomeId, 'Other home');
        await insertMembership(database.pool, {
          id: membershipId,
          homeId,
          userId: targetId,
        });
        await insertMembership(database.pool, {
          id: otherMembershipId,
          homeId: otherHomeId,
          userId: otherId,
        });

        verificationIds.push(
          await insertVerification(database.pool, {
            identifier: `reset-password:${randomUUID()}`,
            value: targetId,
          }),
          await insertVerification(database.pool, {
            identifier: `delete-account-${randomUUID()}`,
            value: targetId,
          }),
          await insertVerification(database.pool, {
            identifier: targetEmail,
            value: 'email-keyed-target',
          }),
          await insertVerification(database.pool, {
            identifier: `reset-password:${randomUUID()}`,
            value: otherId,
          }),
          await insertVerification(database.pool, {
            identifier: otherEmail,
            value: 'email-keyed-other',
          }),
          await insertVerification(database.pool, {
            identifier: `oauth-state-${randomUUID()}`,
            value: JSON.stringify({ userId: targetId, callbackURL: '/' }),
          }),
        );

        const captured = await findCurrentCanonicalIdentityByUser(
          database.pool,
          targetId,
        );
        assert.ok(captured);
        assert.deepEqual(captured, {
          userId: targetId,
          email: targetEmail,
          emailVerified: false,
        });

        const beforeOther = await counts(database.pool, otherId);
        assert.deepEqual(beforeOther, {
          identities: '1',
          accounts: '1',
          sessions: '1',
          verifications: '2',
          users: '1',
          memberships: '1',
        });

        await runInReadCommittedTransaction(database.pool, async (tx) => {
          const insideBefore = await counts(tx, targetId as string);
          assert.deepEqual(insideBefore, {
            identities: '1',
            accounts: '1',
            sessions: '1',
            verifications: '3',
            users: '1',
            memberships: '1',
          });

          await persistence.teardownAuthForIdentity(
            tx,
            authLifecycleIdentityFromCurrent(captured),
          );

          const insideAfter = await counts(tx, targetId as string);
          assert.deepEqual(insideAfter, {
            identities: '0',
            accounts: '0',
            sessions: '0',
            verifications: '0',
            users: '1',
            memberships: '1',
          });
          assert.equal(
            await verificationCountByValue(tx, targetId as string),
            0,
          );
          assert.equal(await verificationCountByIdentifier(tx, targetEmail), 0);
          assert.equal(
            await verificationCountByValue(
              tx,
              JSON.stringify({ userId: targetId, callbackURL: '/' }),
            ),
            1,
          );
        });

        const afterTarget = await counts(database.pool, targetId);
        assert.deepEqual(afterTarget, {
          identities: '0',
          accounts: '0',
          sessions: '0',
          verifications: '0',
          users: '1',
          memberships: '1',
        });
        assert.equal(
          await verificationCountByValue(database.pool, targetId),
          0,
        );
        assert.equal(
          await verificationCountByIdentifier(database.pool, targetEmail),
          0,
        );
        const afterOther = await counts(database.pool, otherId);
        assert.deepEqual(afterOther, beforeOther);
        assert.equal(
          await verificationCountByValue(
            database.pool,
            JSON.stringify({ userId: targetId, callbackURL: '/' }),
          ),
          1,
        );

        const resignup = await provisionCanonicalUser(
          database.pool,
          targetEmail,
        );
        assert.notEqual(resignup, targetId);
        const newUser = await database.pool.query<{ id: string }>(
          'SELECT id::text AS id FROM users WHERE id = $1',
          [resignup],
        );
        assert.equal(newUser.rows[0]?.id, resignup);
        const oldUser = await database.pool.query<{
          id: string;
          deleted_at: Date | null;
        }>('SELECT id::text AS id, deleted_at FROM users WHERE id = $1', [
          targetId,
        ]);
        assert.equal(oldUser.rows[0]?.id, targetId);
        assert.equal(oldUser.rows[0]?.deleted_at, null);
        await cleanup(database.pool, { userIds: [resignup] });
      } finally {
        await cleanup(database.pool, {
          userIds: [targetId, otherId].filter(
            (id): id is string => id !== undefined,
          ),
          homeIds: [homeId, otherHomeId],
          membershipIds: [membershipId, otherMembershipId],
          verificationIds,
        });
        await database.close();
      }
    },
  );

  void it(
    'rolls back every auth row when the caller transaction aborts after teardown',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(testConfig(resolveTestDatabaseUrl()));
      const persistence = createAuthIdentityTeardownPersistence();
      const email = normalizeEmail(`m85-rollback-${randomUUID()}@roomies.test`);
      let userId: string | undefined;
      const verificationIds: string[] = [];

      try {
        userId = await provisionCanonicalUser(database.pool, email);
        await insertAuthAccount(database.pool, userId);
        await insertAuthSession(
          database.pool,
          userId,
          `rollback-${randomUUID()}`,
        );
        verificationIds.push(
          await insertVerification(database.pool, {
            identifier: `reset-password:${randomUUID()}`,
            value: userId,
          }),
          await insertVerification(database.pool, {
            identifier: email,
            value: 'email-keyed-rollback',
          }),
        );
        const before = await counts(database.pool, userId);

        await assert.rejects(
          () =>
            runInReadCommittedTransaction(database.pool, async (tx) => {
              await persistence.teardownAuthForIdentity(tx, {
                userId: userId as string,
                email,
              });
              const inside = await counts(tx, userId as string);
              assert.deepEqual(inside, {
                identities: '0',
                accounts: '0',
                sessions: '0',
                verifications: '0',
                users: '1',
                memberships: '0',
              });
              throw new AuthInfrastructureError();
            }),
          AuthInfrastructureError,
        );

        assert.deepEqual(await counts(database.pool, userId), before);
      } finally {
        await cleanup(database.pool, {
          userIds: userId ? [userId] : [],
          verificationIds,
        });
        await database.close();
      }
    },
  );

  void it(
    'does not open BEGIN or COMMIT itself',
    { skip: skipWithoutDatabase },
    async () => {
      const source = await readFile(
        fileURLToPath(new URL('./auth-identity-teardown.ts', import.meta.url)),
        'utf8',
      );
      assert.doesNotMatch(source, /['"`]BEGIN/);
      assert.doesNotMatch(source, /['"`]COMMIT/);
      assert.doesNotMatch(source, /['"`]ROLLBACK/);
      assert.doesNotMatch(source, /runInReadCommittedTransaction/);
      assert.doesNotMatch(source, /runInRepeatableReadTransaction/);
      assert.doesNotMatch(source, /delete-user/);
      assert.doesNotMatch(source, /auth\.api/);
      assert.doesNotMatch(source, /FROM users/i);
      assert.doesNotMatch(source, /FROM homes/i);
      assert.doesNotMatch(source, /FROM memberships/i);
      assert.doesNotMatch(source, /FOR UPDATE/i);
      assert.doesNotMatch(source, /console\.(?:log|info|debug)\(/);
    },
  );
});
