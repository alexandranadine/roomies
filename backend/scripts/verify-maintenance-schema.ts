#!/usr/bin/env node

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { INSERT_MAINTENANCE_ENTRY_SQL } from '../src/domains/maintenance/index.js';
import {
  assertSafeTestDatabase,
  resolveTestDatabaseUrl,
} from '../src/platform/persistence/test-database.js';

type ColumnRow = {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
};

type Fixture = {
  users: readonly [string, string];
  homes: readonly [string, string];
  memberships: readonly [string, string];
};

const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const RESTRICT_VIOLATION = '23001';
const CREATED = new Date('2026-09-13T12:00:00.000Z');
const RESOLVED = new Date('2026-09-13T13:00:00.000Z');
const EARLY = new Date('2026-09-13T11:00:00.000Z');
const LATE = new Date('2026-09-13T14:00:00.000Z');

function sqlState(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

async function expectSqlFailure(
  client: PoolClient,
  savepoint: string,
  sql: string,
  params: readonly unknown[],
  expectedCode: string | readonly string[],
): Promise<void> {
  const expected =
    typeof expectedCode === 'string' ? [expectedCode] : expectedCode;
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    await client.query(sql, [...params]);
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    assert.ok(
      expected.includes(sqlState(error) ?? ''),
      `${savepoint}: expected SQLSTATE ${expected.join('|')}, got ${sqlState(error) ?? 'none'}`,
    );
    return;
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  assert.fail(`${savepoint}: expected SQLSTATE ${expected.join('|')}`);
}

async function tableColumns(
  client: PoolClient,
  table: string,
): Promise<Map<string, ColumnRow>> {
  const result = await client.query<ColumnRow>(
    `SELECT column_name, data_type, udt_name, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY column_name`,
    [table],
  );
  return new Map(result.rows.map((row) => [row.column_name, row]));
}

async function constraintMap(
  client: PoolClient,
  table: string,
): Promise<Map<string, { contype: string; definition: string }>> {
  const result = await client.query<{
    conname: string;
    contype: string;
    definition: string;
  }>(
    `SELECT conname, contype, pg_get_constraintdef(oid, true) AS definition
     FROM pg_catalog.pg_constraint
     WHERE conrelid = $1::regclass
       AND contype <> 'n'
     ORDER BY conname`,
    [`public.${table}`],
  );
  return new Map(result.rows.map((row) => [row.conname, row]));
}

async function indexMap(
  client: PoolClient,
  table: string,
): Promise<Map<string, string>> {
  const result = await client.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef
     FROM pg_catalog.pg_indexes
     WHERE schemaname = 'public' AND tablename = $1
     ORDER BY indexname`,
    [table],
  );
  return new Map(result.rows.map((row) => [row.indexname, row.indexdef]));
}

function assertColumn(
  columns: Map<string, ColumnRow>,
  name: string,
  udtName: string,
  nullable: 'YES' | 'NO',
  defaultValue: string | null,
): void {
  assert.equal(columns.get(name)?.udt_name, udtName, `${name} type`);
  assert.equal(columns.get(name)?.is_nullable, nullable, `${name} nullability`);
  assert.equal(
    columns.get(name)?.column_default,
    defaultValue,
    `${name} default`,
  );
}

function assertRestrictForeignKey(
  constraints: Map<string, { contype: string; definition: string }>,
  name: string,
  expression: RegExp,
): void {
  assert.equal(constraints.get(name)?.contype, 'f', name);
  assert.match(constraints.get(name)?.definition ?? '', expression, name);
  assert.match(
    constraints.get(name)?.definition ?? '',
    /ON UPDATE RESTRICT ON DELETE RESTRICT/i,
    name,
  );
}

async function verifyCatalog(client: PoolClient): Promise<void> {
  const tables = await client.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name LIKE 'maintenance_%'
     ORDER BY table_name`,
  );
  assert.deepEqual(
    tables.rows.map((row) => row.table_name),
    ['maintenance_audiences', 'maintenance_entries'],
  );

  const nativeEnums = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM pg_catalog.pg_type
     WHERE typnamespace = 'public'::regnamespace
       AND typtype = 'e'
       AND typname LIKE 'maintenance%'`,
  );
  assert.equal(nativeEnums.rows[0]?.count, '0');

  const entries = await tableColumns(client, 'maintenance_entries');
  assert.deepEqual(
    [...entries.keys()],
    [
      'created_at',
      'created_by_membership_id',
      'details',
      'home_id',
      'id',
      'resolved_at',
      'resolved_by_membership_id',
      'status',
      'title',
      'updated_at',
      'visibility',
    ],
  );
  assertColumn(entries, 'id', 'uuid', 'NO', null);
  assertColumn(entries, 'home_id', 'uuid', 'NO', null);
  assertColumn(entries, 'created_by_membership_id', 'uuid', 'NO', null);
  assertColumn(entries, 'visibility', 'text', 'NO', null);
  assertColumn(entries, 'title', 'text', 'NO', null);
  assertColumn(entries, 'details', 'text', 'YES', null);
  assertColumn(entries, 'status', 'text', 'NO', "'OPEN'::text");
  assertColumn(entries, 'resolved_by_membership_id', 'uuid', 'YES', null);
  assertColumn(entries, 'resolved_at', 'timestamptz', 'YES', null);
  assertColumn(entries, 'created_at', 'timestamptz', 'NO', 'now()');
  assertColumn(entries, 'updated_at', 'timestamptz', 'NO', null);

  const audiences = await tableColumns(client, 'maintenance_audiences');
  assert.deepEqual(
    [...audiences.keys()],
    ['created_at', 'home_id', 'maintenance_entry_id', 'membership_id'],
  );
  assertColumn(audiences, 'home_id', 'uuid', 'NO', null);
  assertColumn(audiences, 'maintenance_entry_id', 'uuid', 'NO', null);
  assertColumn(audiences, 'membership_id', 'uuid', 'NO', null);
  assertColumn(audiences, 'created_at', 'timestamptz', 'NO', null);

  const entryConstraints = await constraintMap(client, 'maintenance_entries');
  assert.deepEqual(
    [...entryConstraints.keys()],
    [
      'maintenance_entries_creator_home_membership_fkey',
      'maintenance_entries_details_canonical_check',
      'maintenance_entries_home_id_fkey',
      'maintenance_entries_lifecycle_check',
      'maintenance_entries_pkey',
      'maintenance_entries_resolved_time_check',
      'maintenance_entries_resolver_home_membership_fkey',
      'maintenance_entries_status_check_2a206a64',
      'maintenance_entries_title_canonical_check',
      'maintenance_entries_updated_time_check',
      'maintenance_entries_visibility_check_b1f71ccd',
    ],
  );
  assert.match(
    entryConstraints.get('maintenance_entries_lifecycle_check')?.definition ??
      '',
    /status = 'OPEN'.*resolved_by_membership_id IS NULL.*resolved_at IS NULL.*status = 'RESOLVED'.*resolved_by_membership_id IS NOT NULL.*resolved_at IS NOT NULL/s,
  );
  assert.match(
    entryConstraints.get('maintenance_entries_status_check_2a206a64')
      ?.definition ?? '',
    /status = ANY.*OPEN.*RESOLVED/s,
  );
  assert.match(
    entryConstraints.get('maintenance_entries_visibility_check_b1f71ccd')
      ?.definition ?? '',
    /visibility = ANY.*HOUSEHOLD.*PRIVATE/s,
  );
  assert.match(
    entryConstraints.get('maintenance_entries_title_canonical_check')
      ?.definition ?? '',
    /char_length\(title\).*120.*title = btrim\(title\)/s,
  );
  assert.match(
    entryConstraints.get('maintenance_entries_details_canonical_check')
      ?.definition ?? '',
    /details IS NULL.*char_length\(details\).*4000.*details = btrim\(details\)/s,
  );
  assert.match(
    entryConstraints.get('maintenance_entries_updated_time_check')
      ?.definition ?? '',
    /updated_at >= created_at/,
  );
  assert.match(
    entryConstraints.get('maintenance_entries_resolved_time_check')
      ?.definition ?? '',
    /resolved_at >= created_at.*resolved_at <= updated_at/s,
  );
  assertRestrictForeignKey(
    entryConstraints,
    'maintenance_entries_home_id_fkey',
    /FOREIGN KEY \(home_id\).*homes\(id\)/i,
  );
  assertRestrictForeignKey(
    entryConstraints,
    'maintenance_entries_creator_home_membership_fkey',
    /FOREIGN KEY \(home_id, created_by_membership_id\).*memberships\(home_id, id\)/i,
  );
  assertRestrictForeignKey(
    entryConstraints,
    'maintenance_entries_resolver_home_membership_fkey',
    /FOREIGN KEY \(home_id, resolved_by_membership_id\).*memberships\(home_id, id\)/i,
  );

  const audienceConstraints = await constraintMap(
    client,
    'maintenance_audiences',
  );
  assert.deepEqual(
    [...audienceConstraints.keys()],
    [
      'maintenance_audiences_entry_home_fkey',
      'maintenance_audiences_home_id_fkey',
      'maintenance_audiences_home_membership_fkey',
      'maintenance_audiences_pkey',
    ],
  );
  assertRestrictForeignKey(
    audienceConstraints,
    'maintenance_audiences_home_id_fkey',
    /FOREIGN KEY \(home_id\).*homes\(id\)/i,
  );
  assertRestrictForeignKey(
    audienceConstraints,
    'maintenance_audiences_entry_home_fkey',
    /FOREIGN KEY \(home_id, maintenance_entry_id\).*maintenance_entries\(home_id, id\)/i,
  );
  assertRestrictForeignKey(
    audienceConstraints,
    'maintenance_audiences_home_membership_fkey',
    /FOREIGN KEY \(home_id, membership_id\).*memberships\(home_id, id\)/i,
  );

  const entryIndexes = await indexMap(client, 'maintenance_entries');
  assert.deepEqual(
    [...entryIndexes.keys()],
    [
      'maintenance_entries_home_id_created_by_membership_id_i_889ed7bc',
      'maintenance_entries_home_id_id_key_2f2cccd8',
      'maintenance_entries_home_id_idx_f881d5c1',
      'maintenance_entries_home_id_resolved_by_membership_id__4c1f3348',
      'maintenance_entries_home_open_idx_9084003b',
      'maintenance_entries_home_resolved_idx_af0912c3',
      'maintenance_entries_pkey',
    ],
  );
  assert.match(
    entryIndexes.get('maintenance_entries_home_id_id_key_2f2cccd8') ?? '',
    /UNIQUE INDEX.*\(home_id, id\)/i,
  );
  assert.match(
    entryIndexes.get('maintenance_entries_home_open_idx_9084003b') ?? '',
    /\(home_id, updated_at, id\).*WHERE.*status = 'OPEN'/i,
  );
  assert.match(
    entryIndexes.get('maintenance_entries_home_resolved_idx_af0912c3') ?? '',
    /\(home_id, updated_at, id\).*WHERE.*status = 'RESOLVED'/i,
  );

  const audienceIndexes = await indexMap(client, 'maintenance_audiences');
  assert.deepEqual(
    [...audienceIndexes.keys()],
    [
      'maintenance_audiences_home_id_idx_f881d5c1',
      'maintenance_audiences_home_id_maintenance_entry_id_idx_07136f46',
      'maintenance_audiences_home_id_membership_id_idx_3d66ba27',
      'maintenance_audiences_home_membership_entry_idx_478378c9',
      'maintenance_audiences_pkey',
    ],
  );
  assert.match(
    audienceIndexes.get('maintenance_audiences_pkey') ?? '',
    /UNIQUE INDEX.*\(home_id, maintenance_entry_id, membership_id\)/i,
  );
  assert.match(
    audienceIndexes.get(
      'maintenance_audiences_home_membership_entry_idx_478378c9',
    ) ?? '',
    /\(home_id, membership_id, maintenance_entry_id\)/i,
  );

  const triggers = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM pg_catalog.pg_trigger
     WHERE tgrelid IN (
       'public.maintenance_entries'::regclass,
       'public.maintenance_audiences'::regclass
     )
       AND NOT tgisinternal`,
  );
  assert.equal(triggers.rows[0]?.count, '0');
  const policies = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM pg_catalog.pg_policy
     WHERE polrelid IN (
       'public.maintenance_entries'::regclass,
       'public.maintenance_audiences'::regclass
     )`,
  );
  assert.equal(policies.rows[0]?.count, '0');
  console.log('Maintenance catalog verification passed.');
}

function fixtureIds(suffix: string): Fixture {
  return {
    users: [
      `11000000-0000-4000-8000-0000000000${suffix}`,
      `12000000-0000-4000-8000-0000000000${suffix}`,
    ],
    homes: [
      `21000000-0000-4000-8000-0000000000${suffix}`,
      `22000000-0000-4000-8000-0000000000${suffix}`,
    ],
    memberships: [
      `31000000-0000-4000-8000-0000000000${suffix}`,
      `32000000-0000-4000-8000-0000000000${suffix}`,
    ],
  };
}

async function createFixture(
  client: PoolClient,
  suffix: string,
): Promise<Fixture> {
  const fixture = fixtureIds(suffix);
  await client.query(
    `INSERT INTO users (id, updated_at)
     VALUES ($1, now()), ($2, now())`,
    [...fixture.users],
  );
  await client.query(
    `INSERT INTO homes (id, name, timezone, updated_at)
     VALUES ($1, 'Maintenance verification', 'UTC', now()),
            ($2, 'Other maintenance home', 'UTC', now())`,
    [...fixture.homes],
  );
  await client.query(
    `INSERT INTO memberships (id, home_id, user_id, role, ended_at, ended_by_membership_id)
     VALUES ($1, $3, $5, 'ADMIN', NULL, NULL),
            ($2, $4, $6, 'ADMIN', NULL, NULL)`,
    [
      fixture.memberships[0],
      fixture.memberships[1],
      fixture.homes[0],
      fixture.homes[1],
      fixture.users[0],
      fixture.users[1],
    ],
  );
  return fixture;
}

async function cleanupFixture(
  client: PoolClient,
  fixture: Fixture,
): Promise<void> {
  await client.query(
    'DELETE FROM maintenance_audiences WHERE home_id = ANY($1::uuid[])',
    [fixture.homes],
  );
  await client.query(
    'DELETE FROM maintenance_entries WHERE home_id = ANY($1::uuid[])',
    [fixture.homes],
  );
  await client.query(
    'DELETE FROM memberships WHERE home_id = ANY($1::uuid[])',
    [fixture.homes],
  );
  await client.query('DELETE FROM homes WHERE id = ANY($1::uuid[])', [
    fixture.homes,
  ]);
  await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
    fixture.users,
  ]);
}

function entryParams(
  id: string,
  fixture: Fixture,
  overrides: {
    homeId?: string;
    creatorId?: string;
    visibility?: string;
    title?: string;
    details?: string | null;
    status?: string;
    resolverId?: string | null;
    resolvedAt?: Date | null;
    createdAt?: Date;
    updatedAt?: Date;
  } = {},
): unknown[] {
  return [
    id,
    overrides.homeId ?? fixture.homes[0],
    overrides.creatorId ?? fixture.memberships[0],
    overrides.visibility ?? 'HOUSEHOLD',
    overrides.title ?? `Maintenance ${id.slice(-4)}`,
    overrides.details === undefined ? null : overrides.details,
    overrides.status ?? 'OPEN',
    overrides.resolverId === undefined ? null : overrides.resolverId,
    overrides.resolvedAt === undefined ? null : overrides.resolvedAt,
    overrides.createdAt ?? CREATED,
    overrides.updatedAt ?? CREATED,
  ];
}

async function verifyBehavior(pool: Pool): Promise<void> {
  const client = await pool.connect();
  let fixture: Fixture | undefined;
  try {
    fixture = await createFixture(client, '21');
    let serial = 1;
    const nextId = () =>
      `41000000-0000-7000-8000-${String(serial++).padStart(12, '0')}`;

    await client.query('BEGIN');
    const openId = nextId();
    await client.query(
      INSERT_MAINTENANCE_ENTRY_SQL,
      entryParams(openId, fixture),
    );
    const resolvedId = nextId();
    await client.query(
      INSERT_MAINTENANCE_ENTRY_SQL,
      entryParams(resolvedId, fixture, {
        status: 'RESOLVED',
        resolverId: fixture.memberships[0],
        resolvedAt: RESOLVED,
        updatedAt: RESOLVED,
      }),
    );

    const corruptions: ReadonlyArray<
      readonly [string, Parameters<typeof entryParams>[2]]
    > = [
      ['invalid_status', { status: 'CANCELED' }],
      ['invalid_visibility', { visibility: 'SECRET' }],
      ['open_with_resolver', { resolverId: fixture.memberships[0] }],
      ['open_with_resolved_at', { resolvedAt: RESOLVED }],
      [
        'resolved_without_resolver',
        { status: 'RESOLVED', resolvedAt: RESOLVED, updatedAt: RESOLVED },
      ],
      [
        'resolved_without_time',
        { status: 'RESOLVED', resolverId: fixture.memberships[0] },
      ],
      ['empty_title', { title: '' }],
      ['padded_title', { title: '  padded  ' }],
      ['overlong_title', { title: 'x'.repeat(121) }],
      ['empty_details', { details: '' }],
      ['padded_details', { details: '  padded  ' }],
      ['overlong_details', { details: 'x'.repeat(4001) }],
      ['updated_before_created', { updatedAt: EARLY }],
      [
        'resolved_before_created',
        {
          status: 'RESOLVED',
          resolverId: fixture.memberships[0],
          resolvedAt: EARLY,
          updatedAt: RESOLVED,
        },
      ],
      [
        'resolved_after_updated',
        {
          status: 'RESOLVED',
          resolverId: fixture.memberships[0],
          resolvedAt: LATE,
          updatedAt: RESOLVED,
        },
      ],
    ];
    for (const [name, overrides] of corruptions) {
      await expectSqlFailure(
        client,
        name,
        INSERT_MAINTENANCE_ENTRY_SQL,
        entryParams(nextId(), fixture, overrides),
        CHECK_VIOLATION,
      );
    }
    assert.equal(corruptions.length, 15);

    await expectSqlFailure(
      client,
      'entry_cross_home_creator',
      INSERT_MAINTENANCE_ENTRY_SQL,
      entryParams(nextId(), fixture, { creatorId: fixture.memberships[1] }),
      FOREIGN_KEY_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'entry_cross_home_resolver',
      INSERT_MAINTENANCE_ENTRY_SQL,
      entryParams(nextId(), fixture, {
        status: 'RESOLVED',
        resolverId: fixture.memberships[1],
        resolvedAt: RESOLVED,
        updatedAt: RESOLVED,
      }),
      FOREIGN_KEY_VIOLATION,
    );

    const audienceSql = `
      INSERT INTO maintenance_audiences (
        home_id, maintenance_entry_id, membership_id, created_at
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz)
    `;
    await expectSqlFailure(
      client,
      'audience_cross_home_membership',
      audienceSql,
      [fixture.homes[0], openId, fixture.memberships[1], CREATED],
      FOREIGN_KEY_VIOLATION,
    );
    const otherOpen = nextId();
    await client.query(
      INSERT_MAINTENANCE_ENTRY_SQL,
      entryParams(otherOpen, fixture, {
        homeId: fixture.homes[1],
        creatorId: fixture.memberships[1],
      }),
    );
    await expectSqlFailure(
      client,
      'audience_wrong_home_entry',
      audienceSql,
      [fixture.homes[0], otherOpen, fixture.memberships[0], CREATED],
      FOREIGN_KEY_VIOLATION,
    );

    await expectSqlFailure(
      client,
      'delete_referenced_home',
      'DELETE FROM homes WHERE id = $1',
      [fixture.homes[0]],
      [RESTRICT_VIOLATION, FOREIGN_KEY_VIOLATION],
    );
    await expectSqlFailure(
      client,
      'delete_referenced_membership',
      'DELETE FROM memberships WHERE id = $1',
      [fixture.memberships[0]],
      [RESTRICT_VIOLATION, FOREIGN_KEY_VIOLATION],
    );

    const outbox = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM outbox_events
       WHERE home_id = ANY($1::uuid[]) AND event_type LIKE 'maintenance.%'`,
      [fixture.homes],
    );
    assert.equal(outbox.rows[0]?.count, '0');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    try {
      if (fixture) {
        await cleanupFixture(client, fixture);
      }
    } finally {
      client.release();
    }
  }
  console.log(
    'Maintenance lifecycle, cross-Home, and constraint probes passed.',
  );
}

export async function verifyMaintenanceSchema(
  databaseUrl: string,
): Promise<void> {
  assertSafeTestDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    const client = await pool.connect();
    try {
      await verifyCatalog(client);
    } finally {
      client.release();
    }
    await verifyBehavior(pool);
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  await verifyMaintenanceSchema(resolveTestDatabaseUrl());
}
