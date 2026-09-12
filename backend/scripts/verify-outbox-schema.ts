#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import {
  assertSafeTestDatabase,
  resolveTestDatabaseUrl,
} from '../src/platform/persistence/test-database.js';

type CountResult = { count: string };
type NameResult = { name: string };
type IndexDefResult = { indexdef: string };

const CHECK_VIOLATION = '23514';
const NOT_NULL_VIOLATION = '23502';
const UNIQUE_VIOLATION = '23505';
const STRING_DATA_RIGHT_TRUNCATION = '22001';

const REQUIRED_INDEXES = [
  'outbox_events_pkey',
  'outbox_events_claim_idx',
  'outbox_events_processed_prune_idx',
  'outbox_events_dead_prune_idx',
] as const;

const REQUIRED_CHECKS = [
  'outbox_events_event_type_format_check',
  'outbox_events_payload_object_check',
  'outbox_events_attempt_count_check',
  'outbox_events_terminal_state_check',
  'outbox_events_lease_completeness_check',
  'outbox_events_lease_order_check',
  'outbox_events_terminal_not_leased_check',
  'outbox_events_error_code_format_check',
] as const;

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

async function insertOutboxEvent(
  client: PoolClient,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const eventId =
    typeof overrides['event_id'] === 'string'
      ? overrides['event_id']
      : randomUUID();
  const columns = {
    event_id: eventId,
    event_type: 'membership.ended.v1',
    occurred_at: new Date('2026-09-12T20:00:00.000Z'),
    payload: {},
    ...overrides,
  };

  const names = Object.keys(columns);
  const values = names.map((_, index) => `$${String(index + 1)}`);
  await client.query(
    `INSERT INTO public.outbox_events (${names.join(', ')})
     VALUES (${values.join(', ')})`,
    names.map((name) => columns[name]),
  );
  return eventId;
}

async function verifyCatalog(client: PoolClient): Promise<void> {
  const columnResult = await client.query<{
    column_name: string;
    data_type: string;
    udt_name: string;
    is_nullable: string;
    column_default: string | null;
    character_maximum_length: number | null;
  }>(`
    SELECT
      column_name,
      data_type,
      udt_name,
      is_nullable,
      column_default,
      character_maximum_length
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'outbox_events'
    ORDER BY column_name
  `);

  const columns = Object.fromEntries(
    columnResult.rows.map((row) => [row.column_name, row]),
  );

  assert.deepEqual(Object.keys(columns), [
    'attempt_count',
    'available_at',
    'created_at',
    'dead_at',
    'event_id',
    'event_type',
    'home_id',
    'last_error_code',
    'last_failed_at',
    'lease_owner',
    'lease_until',
    'leased_at',
    'occurred_at',
    'payload',
    'processed_at',
  ]);
  assert.equal('initiating_membership_id' in columns, false);

  assert.equal(columns['event_id']?.udt_name, 'uuid');
  assert.equal(columns['event_id']?.is_nullable, 'NO');
  assert.equal(columns['event_id']?.column_default, null);
  assert.equal(columns['home_id']?.udt_name, 'uuid');
  assert.equal(columns['home_id']?.is_nullable, 'YES');
  assert.equal(columns['lease_owner']?.udt_name, 'uuid');

  for (const name of [
    'occurred_at',
    'created_at',
    'available_at',
    'leased_at',
    'lease_until',
    'processed_at',
    'dead_at',
    'last_failed_at',
  ]) {
    assert.equal(columns[name]?.udt_name, 'timestamptz', name);
  }
  assert.equal(columns['created_at']?.column_default, 'now()');
  assert.equal(columns['available_at']?.column_default, 'now()');

  assert.equal(columns['payload']?.udt_name, 'jsonb');
  assert.equal(columns['payload']?.is_nullable, 'NO');
  assert.equal(columns['event_type']?.data_type, 'character varying');
  assert.equal(columns['event_type']?.character_maximum_length, 200);
  assert.equal(columns['last_error_code']?.data_type, 'character varying');
  assert.equal(columns['last_error_code']?.character_maximum_length, 100);
  assert.equal(columns['attempt_count']?.udt_name, 'int4');
  assert.equal(columns['attempt_count']?.column_default, '0');

  const foreignKeys = await client.query<CountResult>(`
    SELECT COUNT(*)::text AS count
    FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = 'public.outbox_events'::pg_catalog.regclass
      AND c.contype = 'f'
  `);
  assert.equal(foreignKeys.rows[0]?.count, '0');

  const checkNames = await client.query<NameResult>(`
    SELECT c.conname AS name
    FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = 'public.outbox_events'::pg_catalog.regclass
      AND c.contype = 'c'
    ORDER BY c.conname
  `);
  assert.deepEqual(
    checkNames.rows.map((row) => row.name),
    [...REQUIRED_CHECKS].sort(),
  );

  const payloadSizeChecks = await client.query<CountResult>(`
    SELECT COUNT(*)::text AS count
    FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = 'public.outbox_events'::pg_catalog.regclass
      AND c.contype = 'c'
      AND (
        c.conname = 'outbox_events_payload_size_check'
        OR pg_catalog.pg_get_constraintdef(c.oid) ILIKE '%octet_length%'
        OR pg_catalog.pg_get_constraintdef(c.oid) ILIKE '%65536%'
      )
  `);
  assert.equal(payloadSizeChecks.rows[0]?.count, '0');

  const indexNames = await client.query<NameResult>(`
    SELECT i.relname AS name
    FROM pg_catalog.pg_index AS idx
    INNER JOIN pg_catalog.pg_class AS i ON i.oid = idx.indexrelid
    WHERE idx.indrelid = 'public.outbox_events'::pg_catalog.regclass
    ORDER BY i.relname
  `);
  assert.deepEqual(
    indexNames.rows.map((row) => row.name),
    [...REQUIRED_INDEXES].sort(),
  );

  const claimIndex = await client.query<IndexDefResult>(`
    SELECT pg_catalog.pg_get_indexdef('public.outbox_events_claim_idx'::regclass)
      AS indexdef
  `);
  const claimDef = claimIndex.rows[0]?.indexdef ?? '';
  assert.match(claimDef, /processed_at IS NULL/i);
  assert.match(claimDef, /dead_at IS NULL/i);
  assert.doesNotMatch(claimDef, /\bnow\s*\(/i);

  const existingTables = await client.query<CountResult>(`
    SELECT COUNT(*)::text AS count
    FROM pg_catalog.pg_class AS c
    INNER JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname IN (
        'users',
        'homes',
        'memberships',
        'auth_identities',
        'auth_accounts',
        'auth_sessions',
        'auth_verifications'
      )
  `);
  assert.equal(existingTables.rows[0]?.count, '7');

  console.log('Outbox catalog and index verification passed.');
}

async function verifyConstraints(client: PoolClient): Promise<void> {
  await inRollbackTransaction(client, async () => {
    await insertOutboxEvent(client);
    await insertOutboxEvent(client, {
      event_type: 'membership.role_changed.v1',
    });
    await insertOutboxEvent(client, { event_type: 'home.archived.v1' });
    await insertOutboxEvent(client, { payload: {} });
    await insertOutboxEvent(client, { payload: { kind: 'object' } });
    await insertOutboxEvent(client, { attempt_count: 0 });
    await insertOutboxEvent(client, { attempt_count: 3 });
    await insertOutboxEvent(client, {
      lease_owner: null,
      leased_at: null,
      lease_until: null,
    });
    await insertOutboxEvent(client, {
      lease_owner: randomUUID(),
      leased_at: new Date('2026-09-12T20:00:00.000Z'),
      lease_until: new Date('2026-09-12T20:05:00.000Z'),
    });
    await insertOutboxEvent(client, { processed_at: new Date() });
    await insertOutboxEvent(client, { dead_at: new Date() });
    await insertOutboxEvent(client, { last_error_code: null });
    await insertOutboxEvent(client, { last_error_code: 'TIMEOUT' });
    await insertOutboxEvent(client, {
      last_error_code: 'DEPENDENCY_UNAVAILABLE',
    });

    const duplicateId = randomUUID();
    await insertOutboxEvent(client, { event_id: duplicateId });
    await expectSqlFailure(
      client,
      'dup_event_id',
      `INSERT INTO public.outbox_events
         (event_id, event_type, occurred_at, payload)
       VALUES ($1, 'membership.ended.v1', NOW(), '{}'::jsonb)`,
      [duplicateId],
      UNIQUE_VIOLATION,
    );

    await expectSqlFailure(
      client,
      'bad_event_type',
      `INSERT INTO public.outbox_events
         (event_id, event_type, occurred_at, payload)
       VALUES ($1, 'Membership.Ended.V1', NOW(), '{}'::jsonb)`,
      [randomUUID()],
      CHECK_VIOLATION,
    );

    await expectSqlFailure(
      client,
      'payload_array',
      `INSERT INTO public.outbox_events
         (event_id, event_type, occurred_at, payload)
       VALUES ($1, 'membership.ended.v1', NOW(), '[]'::jsonb)`,
      [randomUUID()],
      CHECK_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'payload_string',
      `INSERT INTO public.outbox_events
         (event_id, event_type, occurred_at, payload)
       VALUES ($1, 'membership.ended.v1', NOW(), '"text"'::jsonb)`,
      [randomUUID()],
      CHECK_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'payload_json_null',
      `INSERT INTO public.outbox_events
         (event_id, event_type, occurred_at, payload)
       VALUES ($1, 'membership.ended.v1', NOW(), 'null'::jsonb)`,
      [randomUUID()],
      CHECK_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'payload_sql_null',
      `INSERT INTO public.outbox_events
         (event_id, event_type, occurred_at, payload)
       VALUES ($1, 'membership.ended.v1', NOW(), NULL)`,
      [randomUUID()],
      NOT_NULL_VIOLATION,
    );

    await expectSqlFailure(
      client,
      'negative_attempts',
      `INSERT INTO public.outbox_events
         (event_id, event_type, occurred_at, payload, attempt_count)
       VALUES ($1, 'membership.ended.v1', NOW(), '{}'::jsonb, -1)`,
      [randomUUID()],
      CHECK_VIOLATION,
    );

    await expectSqlFailure(
      client,
      'partial_lease',
      `INSERT INTO public.outbox_events
         (event_id, event_type, occurred_at, payload, lease_owner)
       VALUES ($1, 'membership.ended.v1', NOW(), '{}'::jsonb, $2)`,
      [randomUUID(), randomUUID()],
      CHECK_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'lease_order',
      `INSERT INTO public.outbox_events
         (event_id, event_type, occurred_at, payload,
          lease_owner, leased_at, lease_until)
       VALUES (
         $1, 'membership.ended.v1', NOW(), '{}'::jsonb,
         $2, TIMESTAMPTZ '2026-09-12 20:05:00+00',
         TIMESTAMPTZ '2026-09-12 20:05:00+00'
       )`,
      [randomUUID(), randomUUID()],
      CHECK_VIOLATION,
    );

    await expectSqlFailure(
      client,
      'processed_and_dead',
      `INSERT INTO public.outbox_events
         (event_id, event_type, occurred_at, payload, processed_at, dead_at)
       VALUES ($1, 'membership.ended.v1', NOW(), '{}'::jsonb, NOW(), NOW())`,
      [randomUUID()],
      CHECK_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'processed_and_lease',
      `INSERT INTO public.outbox_events
         (event_id, event_type, occurred_at, payload,
          processed_at, lease_owner, leased_at, lease_until)
       VALUES (
         $1, 'membership.ended.v1', NOW(), '{}'::jsonb, NOW(),
         $2, NOW(), NOW() + INTERVAL '5 minutes'
       )`,
      [randomUUID(), randomUUID()],
      CHECK_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'dead_and_lease',
      `INSERT INTO public.outbox_events
         (event_id, event_type, occurred_at, payload,
          dead_at, lease_owner, leased_at, lease_until)
       VALUES (
         $1, 'membership.ended.v1', NOW(), '{}'::jsonb, NOW(),
         $2, NOW(), NOW() + INTERVAL '5 minutes'
       )`,
      [randomUUID(), randomUUID()],
      CHECK_VIOLATION,
    );

    await expectSqlFailure(
      client,
      'error_lowercase',
      `INSERT INTO public.outbox_events
         (event_id, event_type, occurred_at, payload, last_error_code)
       VALUES ($1, 'membership.ended.v1', NOW(), '{}'::jsonb, 'timeout')`,
      [randomUUID()],
      CHECK_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'error_spaces',
      `INSERT INTO public.outbox_events
         (event_id, event_type, occurred_at, payload, last_error_code)
       VALUES ($1, 'membership.ended.v1', NOW(), '{}'::jsonb, 'TIME OUT')`,
      [randomUUID()],
      CHECK_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'error_punct',
      `INSERT INTO public.outbox_events
         (event_id, event_type, occurred_at, payload, last_error_code)
       VALUES ($1, 'membership.ended.v1', NOW(), '{}'::jsonb, 'TIME-OUT')`,
      [randomUUID()],
      CHECK_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'error_too_long',
      `INSERT INTO public.outbox_events
         (event_id, event_type, occurred_at, payload, last_error_code)
       VALUES ($1, 'membership.ended.v1', NOW(), '{}'::jsonb, $2)`,
      [randomUUID(), `${'A'.repeat(101)}`],
      STRING_DATA_RIGHT_TRUNCATION,
    );
  });

  console.log('Outbox constraint verification passed.');
}

export async function verifyOutboxSchema(databaseUrl: string): Promise<void> {
  assertSafeTestDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });

  try {
    const client = await pool.connect();
    try {
      await verifyCatalog(client);
      await verifyConstraints(client);
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
  await verifyOutboxSchema(databaseUrl);
}
