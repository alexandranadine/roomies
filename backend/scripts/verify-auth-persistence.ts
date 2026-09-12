#!/usr/bin/env node

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { assertNoNormalizedEmailCollisions } from '../src/platform/auth/normalized-email-collision-audit.js';
import {
  assertSafeTestDatabase,
  resolveTestDatabaseUrl,
} from '../src/platform/persistence/test-database.js';

type BooleanResult = { result: boolean };
type CountResult = { count: string };
type IdResult = { id: string };

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sqlState(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }

  return undefined;
}

async function expectSqlFailure(
  client: PoolClient,
  savepoint: string,
  sql: string,
  params: readonly unknown[],
  expectedCode: string,
): Promise<void> {
  await client.query(`SAVEPOINT ${savepoint}`);

  try {
    await client.query(sql, [...params]);
  } catch (error: unknown) {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    assert.equal(sqlState(error), expectedCode);
    return;
  }

  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  assert.fail(`Expected SQLSTATE ${expectedCode}`);
}

async function inRollbackTransaction(
  client: PoolClient,
  test: () => Promise<void>,
): Promise<void> {
  await client.query('BEGIN');
  try {
    await test();
  } finally {
    await client.query('ROLLBACK');
  }
}

async function verifyCatalog(client: PoolClient): Promise<void> {
  const functionResult = await client.query<BooleanResult>(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS p
      INNER JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      INNER JOIN pg_catalog.pg_language AS l ON l.oid = p.prolang
      WHERE n.nspname = 'public'
        AND p.proname = 'provision_user_for_auth_identity'
        AND p.pronargs = 0
        AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
        AND p.prosecdef = false
        AND l.lanname = 'plpgsql'
        AND COALESCE(p.proconfig, ARRAY[]::text[])
          @> ARRAY['search_path=pg_catalog']
        AND POSITION(
          'insert into public.users (id, updated_at) values (new.id, current_timestamp);'
          IN pg_catalog.regexp_replace(
            pg_catalog.lower(p.prosrc),
            '[[:space:]]+',
            ' ',
            'g'
          )
        ) > 0
        AND POSITION(
          'return new;'
          IN pg_catalog.regexp_replace(
            pg_catalog.lower(p.prosrc),
            '[[:space:]]+',
            ' ',
            'g'
          )
        ) > 0
        AND POSITION('on conflict' IN pg_catalog.lower(p.prosrc)) = 0
        AND POSITION('exception' IN pg_catalog.lower(p.prosrc)) = 0
    ) AS result
  `);
  assert.equal(functionResult.rows[0]?.result, true);

  const triggerResult = await client.query<BooleanResult>(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS t
      WHERE t.tgrelid = to_regclass('public.auth_identities')
        AND t.tgname = 'auth_identities_provision_user'
        AND t.tgenabled = 'O'
        AND t.tgisinternal = false
        AND t.tgtype = 7
        AND t.tgfoid =
          to_regprocedure('public.provision_user_for_auth_identity()')
    ) AS result
  `);
  assert.equal(triggerResult.rows[0]?.result, true);

  const identityForeignKeyResult = await client.query<BooleanResult>(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid = 'public.auth_identities'::pg_catalog.regclass
        AND c.confrelid = 'public.users'::pg_catalog.regclass
        AND c.conname = 'auth_identities_id_fkey'
        AND c.contype = 'f'
        AND c.condeferrable = false
        AND c.condeferred = false
        AND c.confdeltype = 'r'
        AND c.confupdtype = 'r'
    ) AS result
  `);
  assert.equal(identityForeignKeyResult.rows[0]?.result, true);

  const cascadingForeignKeysResult = await client.query<CountResult>(`
    SELECT COUNT(*)::text AS count
    FROM pg_catalog.pg_constraint AS c
    WHERE c.conname IN (
      'auth_accounts_user_id_fkey',
      'auth_sessions_user_id_fkey'
    )
      AND c.contype = 'f'
      AND c.confrelid = 'public.auth_identities'::pg_catalog.regclass
      AND c.confdeltype = 'c'
      AND c.confupdtype = 'c'
      AND c.condeferrable = false
      AND c.condeferred = false
  `);
  assert.equal(cascadingForeignKeysResult.rows[0]?.count, '2');

  const canonicalEmailConstraint = await client.query<BooleanResult>(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint
      WHERE conrelid = 'public.auth_identities'::pg_catalog.regclass
        AND conname = 'auth_identities_email_canonical_check'
        AND contype = 'c'
        AND pg_get_constraintdef(oid) !~* '\\mnow\\s*\\('
    ) AS result
  `);
  assert.equal(canonicalEmailConstraint.rows[0]?.result, true);

  console.log('Auth persistence catalog verification passed.');
}

async function verifyCanonicalEmailContract(client: PoolClient): Promise<void> {
  await assertNoNormalizedEmailCollisions(client);
  await inRollbackTransaction(client, async () => {
    await expectSqlFailure(
      client,
      'uppercase_email',
      `INSERT INTO public.auth_identities (name, email, email_verified)
       VALUES ('Uppercase refusal', 'Uppercase@roomies.test', false)`,
      [],
      '23514',
    );
    await expectSqlFailure(
      client,
      'spaced_email',
      `INSERT INTO public.auth_identities (name, email, email_verified)
       VALUES ('Whitespace refusal', ' spaced@roomies.test ', false)`,
      [],
      '23514',
    );
  });
  console.log('Canonical auth email contract verification passed.');
}

async function verifyProvisioning(client: PoolClient): Promise<void> {
  await inRollbackTransaction(client, async () => {
    const inserted = await client.query<IdResult>(`
      INSERT INTO public.auth_identities (
        name,
        email,
        email_verified
      )
      VALUES ('Migration verification', 'provisioning@roomies.test', false)
      RETURNING id::text AS id
    `);
    const id = inserted.rows[0]?.id;
    assert.ok(id);
    assert.match(id, UUID_V4_PATTERN);

    const canonicalUsers = await client.query<CountResult>(
      `
        SELECT COUNT(*)::text AS count
        FROM public.users
        WHERE id = $1::uuid
      `,
      [id],
    );
    assert.equal(canonicalUsers.rows[0]?.count, '1');

    const matchingIdentity = await client.query<CountResult>(
      `
        SELECT COUNT(*)::text AS count
        FROM public.auth_identities
        WHERE id = $1::uuid
      `,
      [id],
    );
    assert.equal(matchingIdentity.rows[0]?.count, '1');
  });

  console.log('Auth identity provisioning verification passed.');
}

async function verifyMappedAuthSchema(client: PoolClient): Promise<void> {
  await inRollbackTransaction(client, async () => {
    const identity = await client.query<IdResult>(`
      INSERT INTO public.auth_identities (name, email, email_verified)
      VALUES ('Mapping verification', 'mapping@roomies.test', false)
      RETURNING id::text AS id
    `);
    const userId = identity.rows[0]?.id;
    assert.ok(userId);

    const account = await client.query<IdResult>(
      `
        INSERT INTO public.auth_accounts (
          account_id,
          provider_id,
          user_id,
          password
        )
        VALUES ($1, 'credential', $2::uuid, 'verification-only-hash')
        RETURNING id::text AS id
      `,
      [userId, userId],
    );
    assert.match(account.rows[0]?.id ?? '', UUID_V4_PATTERN);

    const session = await client.query<IdResult>(
      `
        INSERT INTO public.auth_sessions (
          expires_at,
          token,
          ip_address,
          user_agent,
          user_id
        )
        VALUES (
          CURRENT_TIMESTAMP + INTERVAL '1 hour',
          'mapping-session-token',
          '127.0.0.1',
          'migration-verifier',
          $1::uuid
        )
        RETURNING id::text AS id
      `,
      [userId],
    );
    assert.match(session.rows[0]?.id ?? '', UUID_V4_PATTERN);

    const verification = await client.query<IdResult>(`
      INSERT INTO public.auth_verifications (
        identifier,
        value,
        expires_at
      )
      VALUES (
        'mapping-verification',
        'verification-only-value',
        CURRENT_TIMESTAMP + INTERVAL '10 minutes'
      )
      RETURNING id::text AS id
    `);
    assert.match(verification.rows[0]?.id ?? '', UUID_V4_PATTERN);

    await client.query(
      'DELETE FROM public.auth_identities WHERE id = $1::uuid',
      [userId],
    );

    const authDependents = await client.query<CountResult>(
      `
        SELECT (
          (SELECT COUNT(*) FROM public.auth_accounts WHERE user_id = $1::uuid)
          +
          (SELECT COUNT(*) FROM public.auth_sessions WHERE user_id = $1::uuid)
        )::text AS count
      `,
      [userId],
    );
    assert.equal(authDependents.rows[0]?.count, '0');

    const canonicalUsers = await client.query<CountResult>(
      'SELECT COUNT(*)::text AS count FROM public.users WHERE id = $1::uuid',
      [userId],
    );
    assert.equal(canonicalUsers.rows[0]?.count, '1');

    const verifications = await client.query<CountResult>(`
      SELECT COUNT(*)::text AS count
      FROM public.auth_verifications
      WHERE identifier = 'mapping-verification'
    `);
    assert.equal(verifications.rows[0]?.count, '1');
  });

  console.log('Better Auth 1.7.4 mapped schema verification passed.');
}

async function verifyTriggerFailure(client: PoolClient): Promise<void> {
  await inRollbackTransaction(client, async () => {
    await client.query(`
      ALTER TABLE public.users
      ADD CONSTRAINT users_auth_provision_failure_test_check
      CHECK (false) NOT VALID
    `);

    const usersBefore = await client.query<CountResult>(
      'SELECT COUNT(*)::text AS count FROM public.users',
    );

    await expectSqlFailure(
      client,
      'trigger_failure',
      `
        INSERT INTO public.auth_identities (name, email, email_verified)
        VALUES ('Must fail', 'trigger-failure@roomies.test', false)
      `,
      [],
      '23514',
    );

    const usersAfter = await client.query<CountResult>(
      'SELECT COUNT(*)::text AS count FROM public.users',
    );
    assert.equal(usersAfter.rows[0]?.count, usersBefore.rows[0]?.count);

    const identities = await client.query<CountResult>(`
      SELECT COUNT(*)::text AS count
      FROM public.auth_identities
      WHERE email = 'trigger-failure@roomies.test'
    `);
    assert.equal(identities.rows[0]?.count, '0');
  });

  console.log('Auth identity trigger failure rollback verification passed.');
}

async function verifyDeletionSemantics(client: PoolClient): Promise<void> {
  await inRollbackTransaction(client, async () => {
    const inserted = await client.query<IdResult>(`
      INSERT INTO public.auth_identities (name, email, email_verified)
      VALUES ('Deletion verification', 'deletion@roomies.test', false)
      RETURNING id::text AS id
    `);
    const id = inserted.rows[0]?.id;
    assert.ok(id);

    await client.query(
      'DELETE FROM public.auth_identities WHERE id = $1::uuid',
      [id],
    );

    const identities = await client.query<CountResult>(
      `
        SELECT COUNT(*)::text AS count
        FROM public.auth_identities
        WHERE id = $1::uuid
      `,
      [id],
    );
    assert.equal(identities.rows[0]?.count, '0');

    const users = await client.query<CountResult>(
      `
        SELECT COUNT(*)::text AS count
        FROM public.users
        WHERE id = $1::uuid
      `,
      [id],
    );
    assert.equal(users.rows[0]?.count, '1');
  });

  console.log('Auth identity deletion preserves canonical User.');
}

async function verifyUserRestriction(client: PoolClient): Promise<void> {
  await inRollbackTransaction(client, async () => {
    const inserted = await client.query<IdResult>(`
      INSERT INTO public.auth_identities (name, email, email_verified)
      VALUES ('Restriction verification', 'restriction@roomies.test', false)
      RETURNING id::text AS id
    `);
    const id = inserted.rows[0]?.id;
    assert.ok(id);

    await expectSqlFailure(
      client,
      'user_restriction',
      'DELETE FROM public.users WHERE id = $1::uuid',
      [id],
      '23001',
    );

    const rows = await client.query<CountResult>(
      `
        SELECT COUNT(*)::text AS count
        FROM public.auth_identities AS ai
        INNER JOIN public.users AS u ON u.id = ai.id
        WHERE ai.id = $1::uuid
      `,
      [id],
    );
    assert.equal(rows.rows[0]?.count, '1');
  });

  console.log('Canonical User deletion restriction verification passed.');
}

async function verifyStrictCollision(client: PoolClient): Promise<void> {
  await inRollbackTransaction(client, async () => {
    const idResult = await client.query<IdResult>(
      'SELECT pg_catalog.gen_random_uuid()::text AS id',
    );
    const id = idResult.rows[0]?.id;
    assert.ok(id);

    await client.query(
      `
        INSERT INTO public.users (id, updated_at)
        VALUES ($1::uuid, CURRENT_TIMESTAMP)
      `,
      [id],
    );

    await expectSqlFailure(
      client,
      'strict_collision',
      `
        INSERT INTO public.auth_identities (
          id,
          name,
          email,
          email_verified
        )
        VALUES (
          $1::uuid,
          'Collision verification',
          'collision@roomies.test',
          false
        )
      `,
      [id],
      '23505',
    );

    const identities = await client.query<CountResult>(
      `
        SELECT COUNT(*)::text AS count
        FROM public.auth_identities
        WHERE id = $1::uuid
      `,
      [id],
    );
    assert.equal(identities.rows[0]?.count, '0');

    const users = await client.query<CountResult>(
      `
        SELECT COUNT(*)::text AS count
        FROM public.users
        WHERE id = $1::uuid
      `,
      [id],
    );
    assert.equal(users.rows[0]?.count, '1');
  });

  console.log('Strict canonical User collision verification passed.');
}

export async function verifyAuthPersistence(
  databaseUrl: string,
): Promise<void> {
  assertSafeTestDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });

  try {
    const client = await pool.connect();
    try {
      await verifyCatalog(client);
      await verifyCanonicalEmailContract(client);
      await verifyProvisioning(client);
      await verifyMappedAuthSchema(client);
      await verifyTriggerFailure(client);
      await verifyDeletionSemantics(client);
      await verifyUserRestriction(client);
      await verifyStrictCollision(client);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  const databaseUrl = resolveTestDatabaseUrl();
  await verifyAuthPersistence(databaseUrl);
}
