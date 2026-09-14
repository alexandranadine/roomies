#!/usr/bin/env node

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { INSERT_ACTIVITY_SQL } from '../src/domains/activity/index.js';
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
const UNIQUE_VIOLATION = '23505';
const NOT_NULL_VIOLATION = '23502';
const RESTRICT_VIOLATION = '23001';
const CREATED = new Date('2026-09-13T12:00:00.000Z');
const OCCURRED = new Date('2026-09-13T11:00:00.000Z');

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
     WHERE table_schema = 'public'
       AND table_name IN ('activities', 'activity_recipients')
     ORDER BY table_name`,
  );
  assert.deepEqual(
    tables.rows.map((row) => row.table_name),
    ['activities', 'activity_recipients'],
  );

  const nativeEnums = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM pg_catalog.pg_type
     WHERE typnamespace = 'public'::regnamespace
       AND typtype = 'e'
       AND typname LIKE 'activity%'`,
  );
  assert.equal(nativeEnums.rows[0]?.count, '0');

  const activities = await tableColumns(client, 'activities');
  assert.deepEqual(
    [...activities.keys()],
    [
      'actor_membership_id',
      'created_at',
      'event_type',
      'home_id',
      'id',
      'occurred_at',
      'source_entity_id',
      'source_entity_type',
      'source_outbox_event_id',
      'visibility_class',
    ],
  );
  assertColumn(activities, 'id', 'uuid', 'NO', null);
  assertColumn(activities, 'home_id', 'uuid', 'NO', null);
  assertColumn(activities, 'source_outbox_event_id', 'uuid', 'NO', null);
  assertColumn(activities, 'source_entity_type', 'text', 'NO', null);
  assertColumn(activities, 'source_entity_id', 'uuid', 'NO', null);
  assertColumn(activities, 'event_type', 'varchar', 'NO', null);
  assertColumn(activities, 'visibility_class', 'text', 'NO', null);
  assertColumn(activities, 'actor_membership_id', 'uuid', 'YES', null);
  assertColumn(activities, 'occurred_at', 'timestamptz', 'NO', null);
  assertColumn(activities, 'created_at', 'timestamptz', 'NO', null);
  assert.equal(activities.get('event_type')?.data_type, 'character varying');
  assert.equal(activities.has('user_id'), false);
  assert.equal(activities.has('title'), false);
  assert.equal(activities.has('payload'), false);

  const recipients = await tableColumns(client, 'activity_recipients');
  assert.deepEqual(
    [...recipients.keys()],
    ['activity_id', 'created_at', 'home_id', 'membership_id'],
  );
  assertColumn(recipients, 'home_id', 'uuid', 'NO', null);
  assertColumn(recipients, 'activity_id', 'uuid', 'NO', null);
  assertColumn(recipients, 'membership_id', 'uuid', 'NO', null);
  assertColumn(recipients, 'created_at', 'timestamptz', 'NO', null);
  assert.equal(recipients.has('user_id'), false);
  assert.equal(recipients.has('id'), false);

  const activityConstraints = await constraintMap(client, 'activities');
  assert.deepEqual(
    [...activityConstraints.keys()],
    [
      'activities_actor_home_membership_fkey',
      'activities_event_type_length_check',
      'activities_home_id_fkey',
      'activities_pkey',
      'activities_source_entity_type_check_0ee9d6e1',
      'activities_visibility_class_check_b3389067',
    ],
  );
  assert.match(
    activityConstraints.get('activities_event_type_length_check')?.definition ??
      '',
    /char_length.*event_type.*>= 1.*<= 200/s,
  );
  assert.match(
    activityConstraints.get('activities_source_entity_type_check_0ee9d6e1')
      ?.definition ?? '',
    /source_entity_type = ANY.*MEMBERSHIP.*TASK.*SUPPLY.*MAINTENANCE/s,
  );
  assert.match(
    activityConstraints.get('activities_visibility_class_check_b3389067')
      ?.definition ?? '',
    /visibility_class = ANY.*HOME_VISIBLE.*SOURCE_AUTHORIZED/s,
  );
  assertRestrictForeignKey(
    activityConstraints,
    'activities_home_id_fkey',
    /FOREIGN KEY \(home_id\).*homes\(id\)/i,
  );
  assertRestrictForeignKey(
    activityConstraints,
    'activities_actor_home_membership_fkey',
    /FOREIGN KEY \(home_id, actor_membership_id\).*memberships\(home_id, id\)/i,
  );

  const recipientConstraints = await constraintMap(
    client,
    'activity_recipients',
  );
  assert.deepEqual(
    [...recipientConstraints.keys()],
    [
      'activity_recipients_activity_home_fkey',
      'activity_recipients_home_id_fkey',
      'activity_recipients_home_membership_fkey',
      'activity_recipients_pkey',
    ],
  );
  assertRestrictForeignKey(
    recipientConstraints,
    'activity_recipients_home_id_fkey',
    /FOREIGN KEY \(home_id\).*homes\(id\)/i,
  );
  assertRestrictForeignKey(
    recipientConstraints,
    'activity_recipients_activity_home_fkey',
    /FOREIGN KEY \(home_id, activity_id\).*activities\(home_id, id\)/i,
  );
  assertRestrictForeignKey(
    recipientConstraints,
    'activity_recipients_home_membership_fkey',
    /FOREIGN KEY \(home_id, membership_id\).*memberships\(home_id, id\)/i,
  );

  const activityIndexes = await indexMap(client, 'activities');
  assert.deepEqual(
    [...activityIndexes.keys()],
    [
      'activities_home_feed_idx_ac1573bd',
      'activities_home_id_actor_membership_id_idx_59ee34c2',
      'activities_home_id_id_key_2f2cccd8',
      'activities_home_id_idx_f881d5c1',
      'activities_pkey',
      'activities_source_entity_idx_cd47c954',
      'activities_source_outbox_event_id_key_17bba872',
    ],
  );
  assert.match(
    activityIndexes.get('activities_home_id_id_key_2f2cccd8') ?? '',
    /UNIQUE INDEX.*\(home_id, id\)/i,
  );
  assert.match(
    activityIndexes.get('activities_source_outbox_event_id_key_17bba872') ?? '',
    /UNIQUE INDEX.*\(source_outbox_event_id\)/i,
  );
  assert.match(
    activityIndexes.get('activities_home_feed_idx_ac1573bd') ?? '',
    /\(home_id, occurred_at, id\)/i,
  );
  assert.match(
    activityIndexes.get('activities_source_entity_idx_cd47c954') ?? '',
    /\(source_entity_type, source_entity_id\)/i,
  );

  const recipientIndexes = await indexMap(client, 'activity_recipients');
  assert.deepEqual(
    [...recipientIndexes.keys()],
    [
      'activity_recipients_home_id_activity_id_idx_d6247ab2',
      'activity_recipients_home_id_idx_f881d5c1',
      'activity_recipients_home_id_membership_id_idx_3d66ba27',
      'activity_recipients_home_membership_activity_idx_5cd11f82',
      'activity_recipients_pkey',
    ],
  );
  assert.match(
    recipientIndexes.get('activity_recipients_pkey') ?? '',
    /UNIQUE INDEX.*\(home_id, activity_id, membership_id\)/i,
  );
  assert.match(
    recipientIndexes.get(
      'activity_recipients_home_membership_activity_idx_5cd11f82',
    ) ?? '',
    /\(home_id, membership_id, activity_id\)/i,
  );

  const triggers = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM pg_catalog.pg_trigger
     WHERE tgrelid IN (
       'public.activities'::regclass,
       'public.activity_recipients'::regclass
     )
       AND NOT tgisinternal`,
  );
  assert.equal(triggers.rows[0]?.count, '0');
  const policies = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM pg_catalog.pg_policy
     WHERE polrelid IN (
       'public.activities'::regclass,
       'public.activity_recipients'::regclass
     )`,
  );
  assert.equal(policies.rows[0]?.count, '0');
  console.log('Activity catalog verification passed.');
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
     VALUES ($1, 'Activity verification', 'UTC', now()),
            ($2, 'Other activity home', 'UTC', now())`,
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
    'DELETE FROM activity_recipients WHERE home_id = ANY($1::uuid[])',
    [fixture.homes],
  );
  await client.query('DELETE FROM activities WHERE home_id = ANY($1::uuid[])', [
    fixture.homes,
  ]);
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

function activityParams(
  id: string,
  fixture: Fixture,
  overrides: {
    homeId?: string;
    sourceOutboxEventId?: string;
    sourceEntityType?: string;
    sourceEntityId?: string;
    eventType?: string;
    visibilityClass?: string;
    actorMembershipId?: string | null;
    occurredAt?: Date | null;
    createdAt?: Date | null;
  } = {},
): unknown[] {
  return [
    id,
    overrides.homeId ?? fixture.homes[0],
    overrides.sourceOutboxEventId ?? id,
    overrides.sourceEntityType ?? 'MAINTENANCE',
    overrides.sourceEntityId ?? id,
    overrides.eventType ?? 'maintenance.created.v1',
    overrides.visibilityClass ?? 'HOME_VISIBLE',
    overrides.actorMembershipId === undefined
      ? fixture.memberships[0]
      : overrides.actorMembershipId,
    overrides.occurredAt === undefined ? OCCURRED : overrides.occurredAt,
    overrides.createdAt === undefined ? CREATED : overrides.createdAt,
  ];
}

async function verifyBehavior(pool: Pool): Promise<void> {
  const client = await pool.connect();
  let fixture: Fixture | undefined;
  try {
    fixture = await createFixture(client, '31');
    let serial = 1;
    const nextId = () =>
      `51000000-0000-7000-8000-${String(serial++).padStart(12, '0')}`;

    await client.query('BEGIN');
    const homeVisibleId = nextId();
    await client.query(
      INSERT_ACTIVITY_SQL,
      activityParams(homeVisibleId, fixture),
    );
    const sourceAuthorizedId = nextId();
    await client.query(
      INSERT_ACTIVITY_SQL,
      activityParams(sourceAuthorizedId, fixture, {
        visibilityClass: 'SOURCE_AUTHORIZED',
        actorMembershipId: null,
      }),
    );
    await client.query(
      `INSERT INTO activity_recipients (
         home_id, activity_id, membership_id, created_at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz)`,
      [fixture.homes[0], sourceAuthorizedId, fixture.memberships[0], CREATED],
    );

    const duplicateOutbox = nextId();
    await client.query(
      INSERT_ACTIVITY_SQL,
      activityParams(nextId(), fixture, {
        sourceOutboxEventId: duplicateOutbox,
      }),
    );
    await expectSqlFailure(
      client,
      'duplicate_source_outbox_event',
      INSERT_ACTIVITY_SQL,
      activityParams(nextId(), fixture, {
        sourceOutboxEventId: duplicateOutbox,
      }),
      UNIQUE_VIOLATION,
    );

    await expectSqlFailure(
      client,
      'invalid_visibility',
      INSERT_ACTIVITY_SQL,
      activityParams(nextId(), fixture, { visibilityClass: 'PRIVATE' }),
      CHECK_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'invalid_source_type',
      INSERT_ACTIVITY_SQL,
      activityParams(nextId(), fixture, { sourceEntityType: 'INVITATION' }),
      CHECK_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'empty_event_type',
      INSERT_ACTIVITY_SQL,
      activityParams(nextId(), fixture, { eventType: '' }),
      CHECK_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'actor_cross_home',
      INSERT_ACTIVITY_SQL,
      activityParams(nextId(), fixture, {
        actorMembershipId: fixture.memberships[1],
      }),
      FOREIGN_KEY_VIOLATION,
    );

    const otherActivity = nextId();
    await client.query(
      INSERT_ACTIVITY_SQL,
      activityParams(otherActivity, fixture, {
        homeId: fixture.homes[1],
        actorMembershipId: fixture.memberships[1],
      }),
    );
    const recipientSql = `
      INSERT INTO activity_recipients (
        home_id, activity_id, membership_id, created_at
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz)
    `;
    await expectSqlFailure(
      client,
      'recipient_cross_home_activity',
      recipientSql,
      [fixture.homes[0], otherActivity, fixture.memberships[0], CREATED],
      FOREIGN_KEY_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'recipient_cross_home_membership',
      recipientSql,
      [fixture.homes[0], sourceAuthorizedId, fixture.memberships[1], CREATED],
      FOREIGN_KEY_VIOLATION,
    );

    await expectSqlFailure(
      client,
      'null_occurred_at',
      `INSERT INTO activities (
         id, home_id, source_outbox_event_id, source_entity_type,
         source_entity_id, event_type, visibility_class, occurred_at, created_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'TASK', $1::uuid,
         'task.created.v1', 'HOME_VISIBLE', NULL, $4::timestamptz
       )`,
      [nextId(), fixture.homes[0], nextId(), CREATED],
      NOT_NULL_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'null_created_at',
      `INSERT INTO activities (
         id, home_id, source_outbox_event_id, source_entity_type,
         source_entity_id, event_type, visibility_class, occurred_at, created_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'TASK', $1::uuid,
         'task.created.v1', 'HOME_VISIBLE', $4::timestamptz, NULL
       )`,
      [nextId(), fixture.homes[0], nextId(), OCCURRED],
      NOT_NULL_VIOLATION,
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
  console.log('Activity constraint and cross-Home probes passed.');
}

export async function verifyActivitySchema(databaseUrl: string): Promise<void> {
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
  await verifyActivitySchema(resolveTestDatabaseUrl());
}
