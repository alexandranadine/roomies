#!/usr/bin/env node

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import {
  assertSafeTestDatabase,
  resolveTestDatabaseUrl,
} from '../src/platform/persistence/test-database.js';

/**
 * Recurrence timing is stored, not computed, by this migration.
 *
 * next_occurrence_at is timestamptz. Runtime meaning (later worker):
 * for next recurrence calendar date D, D 00:00:00 in Home.timezone is
 * resolved with Temporal-compatible "compatible" disambiguation:
 * - normal local time → sole instant
 * - nonexistent local time → shift forward by the timezone gap
 * - ambiguous local time → earlier instant/offset
 * Timezone changes later preserve the logical next recurrence date and
 * re-resolve it. There is no time-of-day column.
 *
 * ISO weekday numbering on task_definitions.recurrence_weekday:
 * 1=Monday … 7=Sunday.
 */

type ColumnRow = {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
};

const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const RESTRICT_VIOLATION = '23001';
const UNIQUE_VIOLATION = '23505';

const INSTANCE_CHECKS = [
  'task_instances_completed_time_check',
  'task_instances_completion_state_check',
  'task_instances_source_definition_check',
] as const;

const DEFINITION_CHECKS = [
  'task_definitions_deactivated_time_check',
  'task_definitions_recurrence_config_check',
  'task_definitions_scheduling_lifecycle_check',
] as const;

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
    `
    SELECT column_name, data_type, udt_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY column_name
  `,
    [table],
  );
  return new Map(result.rows.map((row) => [row.column_name, row]));
}

async function constraintMap(
  client: PoolClient,
  table: string,
): Promise<
  Map<string, { conname: string; contype: string; definition: string }>
> {
  const result = await client.query<{
    conname: string;
    contype: string;
    definition: string;
  }>(
    `
    SELECT conname, contype, pg_get_constraintdef(oid, true) AS definition
    FROM pg_catalog.pg_constraint
    WHERE conrelid = $1::regclass
    ORDER BY conname
  `,
    [`public.${table}`],
  );
  return new Map(result.rows.map((row) => [row.conname, row]));
}

async function indexRows(
  client: PoolClient,
  table: string,
): Promise<readonly { indexname: string; indexdef: string }[]> {
  const result = await client.query<{
    indexname: string;
    indexdef: string;
  }>(
    `
    SELECT indexname, indexdef
    FROM pg_catalog.pg_indexes
    WHERE schemaname = 'public' AND tablename = $1
    ORDER BY indexname
  `,
    [table],
  );
  return result.rows;
}

function requireIndex(
  indexes: readonly { indexname: string; indexdef: string }[],
  prefix: string,
): { indexname: string; indexdef: string } {
  const match = indexes.find((row) => row.indexname.startsWith(prefix));
  assert.ok(match, prefix);
  return match;
}

async function indexColumnOptions(
  client: PoolClient,
  indexName: string,
): Promise<readonly { attname: string; indoption: number }[]> {
  const result = await client.query<{
    attname: string;
    indoption: number;
  }>(
    `
    SELECT att.attname, (idx.indoption[ord.ordinality - 1])::int AS indoption
    FROM pg_catalog.pg_index AS idx
    INNER JOIN pg_catalog.pg_class AS cls ON cls.oid = idx.indexrelid
    CROSS JOIN LATERAL unnest(idx.indkey)
      WITH ORDINALITY AS ord(attnum, ordinality)
    INNER JOIN pg_catalog.pg_attribute AS att
      ON att.attrelid = idx.indrelid AND att.attnum = ord.attnum
    WHERE cls.relname = $1
    ORDER BY ord.ordinality
  `,
    [indexName],
  );
  return result.rows;
}

async function verifyCatalog(client: PoolClient): Promise<void> {
  const nativeEnums = await client.query<{ count: string }>(`
    SELECT COUNT(*)::text AS count
    FROM pg_catalog.pg_type
    WHERE typnamespace = 'public'::regnamespace
      AND typtype = 'e'
      AND typname LIKE 'task%'
  `);
  assert.equal(nativeEnums.rows[0]?.count, '0');

  const instanceColumns = await tableColumns(client, 'task_instances');
  assert.deepEqual(
    [...instanceColumns.keys()],
    [
      'assigned_membership_id',
      'completed_at',
      'created_at',
      'home_id',
      'id',
      'scheduled_for',
      'source',
      'status',
      'task_definition_id',
      'title',
      'updated_at',
    ],
  );
  assert.equal(instanceColumns.get('id')?.udt_name, 'uuid');
  assert.equal(instanceColumns.get('id')?.is_nullable, 'NO');
  assert.equal(instanceColumns.get('id')?.column_default, null);
  assert.equal(instanceColumns.get('home_id')?.udt_name, 'uuid');
  assert.equal(instanceColumns.get('home_id')?.is_nullable, 'NO');
  assert.equal(instanceColumns.get('source')?.data_type, 'text');
  assert.equal(instanceColumns.get('source')?.is_nullable, 'NO');
  assert.equal(instanceColumns.get('status')?.data_type, 'text');
  assert.equal(instanceColumns.get('status')?.is_nullable, 'NO');
  assert.match(instanceColumns.get('status')?.column_default ?? '', /OPEN/);
  assert.equal(instanceColumns.get('title')?.data_type, 'text');
  assert.equal(instanceColumns.get('title')?.is_nullable, 'NO');
  assert.equal(instanceColumns.get('scheduled_for')?.data_type, 'date');
  assert.equal(instanceColumns.get('scheduled_for')?.udt_name, 'date');
  assert.equal(instanceColumns.get('scheduled_for')?.is_nullable, 'YES');
  assert.equal(instanceColumns.get('scheduled_for')?.column_default, null);
  assert.equal(instanceColumns.get('assigned_membership_id')?.udt_name, 'uuid');
  assert.equal(
    instanceColumns.get('assigned_membership_id')?.is_nullable,
    'YES',
  );
  assert.equal(instanceColumns.get('task_definition_id')?.udt_name, 'uuid');
  assert.equal(instanceColumns.get('task_definition_id')?.is_nullable, 'YES');
  assert.equal(instanceColumns.get('completed_at')?.udt_name, 'timestamptz');
  assert.equal(instanceColumns.get('completed_at')?.is_nullable, 'YES');
  assert.equal(instanceColumns.get('created_at')?.udt_name, 'timestamptz');
  assert.equal(instanceColumns.get('created_at')?.is_nullable, 'NO');
  assert.equal(instanceColumns.get('created_at')?.column_default, 'now()');
  assert.equal(instanceColumns.get('updated_at')?.udt_name, 'timestamptz');
  assert.equal(instanceColumns.get('updated_at')?.is_nullable, 'NO');
  assert.equal(instanceColumns.has('description'), false);
  assert.equal(instanceColumns.has('creator_membership_id'), false);
  assert.equal(instanceColumns.has('completed_by_membership_id'), false);

  const definitionColumns = await tableColumns(client, 'task_definitions');
  assert.deepEqual(
    [...definitionColumns.keys()],
    [
      'assigned_membership_id',
      'created_at',
      'creator_membership_id',
      'deactivated_at',
      'home_id',
      'id',
      'next_occurrence_at',
      'recurrence_day_of_month',
      'recurrence_frequency',
      'recurrence_weekday',
      'title',
      'updated_at',
    ],
  );
  assert.equal(definitionColumns.get('id')?.udt_name, 'uuid');
  assert.equal(definitionColumns.get('id')?.column_default, null);
  assert.equal(definitionColumns.get('home_id')?.is_nullable, 'NO');
  assert.equal(definitionColumns.get('title')?.is_nullable, 'NO');
  assert.equal(
    definitionColumns.get('creator_membership_id')?.is_nullable,
    'NO',
  );
  assert.equal(
    definitionColumns.get('assigned_membership_id')?.is_nullable,
    'YES',
  );
  assert.equal(
    definitionColumns.get('recurrence_frequency')?.data_type,
    'text',
  );
  assert.equal(definitionColumns.get('recurrence_weekday')?.udt_name, 'int4');
  assert.equal(definitionColumns.get('recurrence_weekday')?.is_nullable, 'YES');
  assert.equal(
    definitionColumns.get('recurrence_day_of_month')?.udt_name,
    'int4',
  );
  assert.equal(
    definitionColumns.get('next_occurrence_at')?.data_type,
    'timestamp with time zone',
  );
  assert.equal(
    definitionColumns.get('next_occurrence_at')?.udt_name,
    'timestamptz',
  );
  assert.equal(definitionColumns.get('next_occurrence_at')?.is_nullable, 'YES');
  assert.equal(
    definitionColumns.get('deactivated_at')?.udt_name,
    'timestamptz',
  );
  assert.equal(definitionColumns.has('cron'), false);
  assert.equal(definitionColumns.has('rrule'), false);
  assert.equal(definitionColumns.has('recurrence'), false);
  assert.equal(definitionColumns.has('time_of_day'), false);

  const instanceConstraints = await constraintMap(client, 'task_instances');
  for (const name of INSTANCE_CHECKS) {
    assert.equal(instanceConstraints.get(name)?.contype, 'c', name);
  }
  assert.match(
    instanceConstraints.get('task_instances_source_definition_check')
      ?.definition ?? '',
    /source = 'MANUAL'.*task_definition_id IS NULL.*source = 'RECURRING'.*task_definition_id IS NOT NULL.*scheduled_for IS NOT NULL/s,
  );
  assert.match(
    instanceConstraints.get('task_instances_completion_state_check')
      ?.definition ?? '',
    /status = 'OPEN'.*completed_at IS NULL.*status = 'COMPLETED'.*completed_at IS NOT NULL/s,
  );
  assert.match(
    instanceConstraints.get('task_instances_completed_time_check')
      ?.definition ?? '',
    /completed_at IS NULL OR completed_at >= created_at/,
  );
  assert.match(
    instanceConstraints.get('task_instances_home_id_fkey')?.definition ?? '',
    /FOREIGN KEY \(home_id\).*homes\(id\).*ON UPDATE RESTRICT ON DELETE RESTRICT/i,
  );
  assert.match(
    instanceConstraints.get('task_instances_assigned_home_membership_fkey')
      ?.definition ?? '',
    /FOREIGN KEY \(home_id, assigned_membership_id\).*memberships\(home_id, id\).*ON UPDATE RESTRICT ON DELETE RESTRICT/i,
  );
  assert.match(
    instanceConstraints.get('task_instances_definition_home_fkey')
      ?.definition ?? '',
    /FOREIGN KEY \(home_id, task_definition_id\).*task_definitions\(home_id, id\).*ON UPDATE RESTRICT ON DELETE RESTRICT/i,
  );

  const definitionConstraints = await constraintMap(client, 'task_definitions');
  for (const name of DEFINITION_CHECKS) {
    assert.equal(definitionConstraints.get(name)?.contype, 'c', name);
  }
  assert.match(
    definitionConstraints.get('task_definitions_recurrence_config_check')
      ?.definition ?? '',
    /DAILY.*recurrence_weekday IS NULL.*recurrence_day_of_month IS NULL.*WEEKLY.*recurrence_weekday.*1.*7.*MONTHLY.*recurrence_day_of_month.*1.*31/s,
  );
  assert.match(
    definitionConstraints.get('task_definitions_scheduling_lifecycle_check')
      ?.definition ?? '',
    /\(deactivated_at IS NULL\) = \(next_occurrence_at IS NOT NULL\)/,
  );
  assert.match(
    definitionConstraints.get('task_definitions_deactivated_time_check')
      ?.definition ?? '',
    /deactivated_at IS NULL OR deactivated_at >= created_at/,
  );
  assert.match(
    definitionConstraints.get('task_definitions_home_id_fkey')?.definition ??
      '',
    /FOREIGN KEY \(home_id\).*homes\(id\).*ON UPDATE RESTRICT ON DELETE RESTRICT/i,
  );
  assert.match(
    definitionConstraints.get('task_definitions_assigned_home_membership_fkey')
      ?.definition ?? '',
    /FOREIGN KEY \(home_id, assigned_membership_id\).*memberships\(home_id, id\).*ON UPDATE RESTRICT ON DELETE RESTRICT/i,
  );
  assert.match(
    definitionConstraints.get('task_definitions_creator_home_membership_fkey')
      ?.definition ?? '',
    /FOREIGN KEY \(home_id, creator_membership_id\).*memberships\(home_id, id\).*ON UPDATE RESTRICT ON DELETE RESTRICT/i,
  );

  const instanceIndexes = await indexRows(client, 'task_instances');
  const openIndex = requireIndex(
    instanceIndexes,
    'task_instances_home_open_idx_',
  );
  assert.match(
    openIndex.indexdef,
    /\(home_id, scheduled_for, created_at, id\).*WHERE.*status = 'OPEN'/i,
  );
  const openOptions = await indexColumnOptions(client, openIndex.indexname);
  assert.deepEqual(
    openOptions.map((row) => [row.attname, row.indoption]),
    [
      ['home_id', 0],
      ['scheduled_for', 0],
      ['created_at', 0],
      ['id', 0],
    ],
  );
  const scheduledForOption = openOptions.find(
    (row) => row.attname === 'scheduled_for',
  );
  // 0 = ASC NULLS LAST (PostgreSQL btree: DESC=1, NULLS FIRST=2).
  assert.equal(scheduledForOption?.indoption, 0);
  assert.doesNotMatch(openIndex.indexdef, /NULLS FIRST/i);

  const completedIndex = requireIndex(
    instanceIndexes,
    'task_instances_home_completed_idx_',
  );
  assert.match(
    completedIndex.indexdef,
    /\(home_id, completed_at, id\).*WHERE.*status = 'COMPLETED'/i,
  );
  const assigneeIndex = requireIndex(
    instanceIndexes,
    'task_instances_home_open_assignee_idx_',
  );
  assert.match(
    assigneeIndex.indexdef,
    /\(home_id, assigned_membership_id, id\).*WHERE.*status = 'OPEN'.*assigned_membership_id IS NOT NULL/i,
  );
  const occurrenceIndex = requireIndex(
    instanceIndexes,
    'task_instances_definition_occurrence_uidx_',
  );
  assert.match(
    occurrenceIndex.indexdef,
    /UNIQUE INDEX .*task_instances_definition_occurrence_uidx_.*\(task_definition_id, scheduled_for\).*WHERE.*task_definition_id IS NOT NULL/i,
  );

  const definitionIndexes = await indexRows(client, 'task_definitions');
  const homeIdKey = requireIndex(
    definitionIndexes,
    'task_definitions_home_id_id_key_',
  );
  assert.match(homeIdKey.indexdef, /UNIQUE INDEX .* \(home_id, id\)/i);
  const activeIndex = requireIndex(
    definitionIndexes,
    'task_definitions_home_active_idx_',
  );
  assert.match(
    activeIndex.indexdef,
    /\(home_id, created_at, id\).*WHERE.*deactivated_at IS NULL/i,
  );
  const workerIndex = requireIndex(
    definitionIndexes,
    'task_definitions_worker_due_idx_',
  );
  assert.match(
    workerIndex.indexdef,
    /\(next_occurrence_at, id\).*WHERE.*deactivated_at IS NULL/i,
  );
  const creatorIndex = requireIndex(
    definitionIndexes,
    'task_definitions_home_creator_idx_',
  );
  assert.match(creatorIndex.indexdef, /\(home_id, creator_membership_id\)/i);
  const activeAssignee = requireIndex(
    definitionIndexes,
    'task_definitions_home_active_assignee_idx_',
  );
  assert.match(
    activeAssignee.indexdef,
    /\(home_id, assigned_membership_id, id\).*WHERE.*deactivated_at IS NULL.*assigned_membership_id IS NOT NULL/i,
  );

  console.log('Task catalog verification passed.');
}

const INSERT_INSTANCE_SQL = `
  INSERT INTO task_instances (
    id, home_id, source, status, title, scheduled_for,
    assigned_membership_id, task_definition_id, completed_at,
    created_at, updated_at
  ) VALUES (
    $1::uuid, $2::uuid, $3, $4, $5, $6::date,
    $7::uuid, $8::uuid, $9::timestamptz,
    $10::timestamptz, $11::timestamptz
  )
`;

const INSERT_DEFINITION_SQL = `
  INSERT INTO task_definitions (
    id, home_id, title, assigned_membership_id, creator_membership_id,
    recurrence_frequency, recurrence_weekday, recurrence_day_of_month,
    next_occurrence_at, deactivated_at, created_at, updated_at
  ) VALUES (
    $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid,
    $6, $7::int, $8::int,
    $9::timestamptz, $10::timestamptz, $11::timestamptz, $12::timestamptz
  )
`;

type Fixture = {
  userA: string;
  userB: string;
  home: string;
  otherHome: string;
  orphanHome: string;
  creator: string;
  assigned: string;
  ended: string;
  otherMembership: string;
};

type InstanceInput = {
  id: string;
  homeId: string;
  source: string;
  status?: string;
  title: string;
  scheduledFor?: string | null;
  assignedMembershipId?: string | null;
  taskDefinitionId?: string | null;
  completedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
};

type DefinitionInput = {
  id: string;
  homeId: string;
  title: string;
  assignedMembershipId?: string | null;
  creatorMembershipId: string;
  frequency: string;
  weekday?: number | null;
  dayOfMonth?: number | null;
  nextOccurrenceAt?: Date | null;
  deactivatedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
};

const CREATED = new Date('2026-09-12T18:00:00.000Z');
const NEXT = new Date('2026-09-13T07:00:00.000Z');
const COMPLETED = new Date('2026-09-12T20:00:00.000Z');
const DEACTIVATED = new Date('2026-09-12T21:00:00.000Z');

async function insertInstance(
  client: PoolClient,
  input: InstanceInput,
): Promise<void> {
  await client.query(INSERT_INSTANCE_SQL, [
    input.id,
    input.homeId,
    input.source,
    input.status ?? 'OPEN',
    input.title,
    input.scheduledFor ?? null,
    input.assignedMembershipId ?? null,
    input.taskDefinitionId ?? null,
    input.completedAt ?? null,
    input.createdAt ?? CREATED,
    input.updatedAt ?? CREATED,
  ]);
}

async function insertDefinition(
  client: PoolClient,
  input: DefinitionInput,
): Promise<void> {
  await client.query(INSERT_DEFINITION_SQL, [
    input.id,
    input.homeId,
    input.title,
    input.assignedMembershipId ?? null,
    input.creatorMembershipId,
    input.frequency,
    input.weekday ?? null,
    input.dayOfMonth ?? null,
    input.nextOccurrenceAt === undefined ? NEXT : input.nextOccurrenceAt,
    input.deactivatedAt ?? null,
    input.createdAt ?? CREATED,
    input.updatedAt ?? CREATED,
  ]);
}

async function createFixture(
  client: PoolClient,
  suffix: string,
): Promise<Fixture> {
  const userA = `10000000-0000-4000-8000-0000000000${suffix}`;
  const userB = `20000000-0000-4000-8000-0000000000${suffix}`;
  const home = `30000000-0000-4000-8000-0000000000${suffix}`;
  const otherHome = `40000000-0000-4000-8000-0000000000${suffix}`;
  const orphanHome = `41000000-0000-4000-8000-0000000000${suffix}`;
  const creator = `50000000-0000-4000-8000-0000000000${suffix}`;
  const assigned = `60000000-0000-4000-8000-0000000000${suffix}`;
  const ended = `65000000-0000-4000-8000-0000000000${suffix}`;
  const otherMembership = `70000000-0000-4000-8000-0000000000${suffix}`;
  await client.query(
    `INSERT INTO users (id, updated_at) VALUES ($1, now()), ($2, now())`,
    [userA, userB],
  );
  await client.query(
    `INSERT INTO homes (id, name, timezone, updated_at)
     VALUES ($1, 'Task home', 'America/Los_Angeles', now()),
            ($2, 'Other home', 'UTC', now()),
            ($3, 'Orphan home', 'UTC', now())`,
    [home, otherHome, orphanHome],
  );
  await client.query(
    `INSERT INTO memberships (id, home_id, user_id, role, ended_at)
     VALUES ($1, $2, $3, 'ADMIN', NULL),
            ($4, $2, $5, 'ROOMMATE', NULL),
            ($6, $2, $5, 'ROOMMATE', TIMESTAMPTZ '2026-09-01T00:00:00Z'),
            ($7, $8, $5, 'ADMIN', NULL)`,
    [creator, home, userA, assigned, userB, ended, otherMembership, otherHome],
  );
  return {
    userA,
    userB,
    home,
    otherHome,
    orphanHome,
    creator,
    assigned,
    ended,
    otherMembership,
  };
}

async function verifyBehavior(client: PoolClient): Promise<void> {
  await client.query('BEGIN');
  try {
    const fixture = await createFixture(client, '01');
    let serial = 1;
    const nextId = () =>
      `80000000-0000-7000-8000-${String(serial++).padStart(12, '0')}`;

    await insertInstance(client, {
      id: nextId(),
      homeId: fixture.home,
      source: 'MANUAL',
      title: 'Undated unassigned',
    });
    await insertInstance(client, {
      id: nextId(),
      homeId: fixture.home,
      source: 'MANUAL',
      title: 'Dated manual',
      scheduledFor: '2026-09-15',
    });
    await insertInstance(client, {
      id: nextId(),
      homeId: fixture.home,
      source: 'MANUAL',
      title: 'Assigned manual',
      scheduledFor: '2026-09-16',
      assignedMembershipId: fixture.assigned,
    });

    const dailyId = nextId();
    await insertDefinition(client, {
      id: dailyId,
      homeId: fixture.home,
      title: 'Daily dishes',
      creatorMembershipId: fixture.creator,
      frequency: 'DAILY',
      assignedMembershipId: fixture.assigned,
    });
    const weeklyId = nextId();
    await insertDefinition(client, {
      id: weeklyId,
      homeId: fixture.home,
      title: 'Weekly trash',
      creatorMembershipId: fixture.creator,
      frequency: 'WEEKLY',
      weekday: 1,
    });
    const monthlyId = nextId();
    await insertDefinition(client, {
      id: monthlyId,
      homeId: fixture.home,
      title: 'Monthly rent',
      creatorMembershipId: fixture.creator,
      frequency: 'MONTHLY',
      dayOfMonth: 15,
    });
    await insertInstance(client, {
      id: nextId(),
      homeId: fixture.home,
      source: 'RECURRING',
      title: 'Daily dishes',
      scheduledFor: '2026-09-13',
      taskDefinitionId: dailyId,
    });
    await insertInstance(client, {
      id: nextId(),
      homeId: fixture.home,
      source: 'MANUAL',
      status: 'COMPLETED',
      title: 'Finished chore',
      completedAt: COMPLETED,
    });
    await insertDefinition(client, {
      id: nextId(),
      homeId: fixture.home,
      title: 'Retired weekly',
      creatorMembershipId: fixture.creator,
      frequency: 'WEEKLY',
      weekday: 7,
      nextOccurrenceAt: null,
      deactivatedAt: DEACTIVATED,
    });
    await insertInstance(client, {
      id: nextId(),
      homeId: fixture.home,
      source: 'MANUAL',
      status: 'COMPLETED',
      title: 'Historical ended assignee',
      assignedMembershipId: fixture.ended,
      completedAt: COMPLETED,
    });

    await expectSqlFailure(
      client,
      'nonexistent_home',
      INSERT_INSTANCE_SQL,
      [
        nextId(),
        crypto.randomUUID(),
        'MANUAL',
        'OPEN',
        'Missing home',
        null,
        null,
        null,
        null,
        CREATED,
        CREATED,
      ],
      FOREIGN_KEY_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'cross_home_task_assignee',
      INSERT_INSTANCE_SQL,
      [
        nextId(),
        fixture.home,
        'MANUAL',
        'OPEN',
        'Cross assignee',
        null,
        fixture.otherMembership,
        null,
        null,
        CREATED,
        CREATED,
      ],
      FOREIGN_KEY_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'cross_home_definition_assignee',
      INSERT_DEFINITION_SQL,
      [
        nextId(),
        fixture.home,
        'Cross assignee def',
        fixture.otherMembership,
        fixture.creator,
        'DAILY',
        null,
        null,
        NEXT,
        null,
        CREATED,
        CREATED,
      ],
      FOREIGN_KEY_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'cross_home_definition_creator',
      INSERT_DEFINITION_SQL,
      [
        nextId(),
        fixture.home,
        'Cross creator def',
        null,
        fixture.otherMembership,
        'DAILY',
        null,
        null,
        NEXT,
        null,
        CREATED,
        CREATED,
      ],
      FOREIGN_KEY_VIOLATION,
    );
    const otherDaily = nextId();
    await insertDefinition(client, {
      id: otherDaily,
      homeId: fixture.otherHome,
      title: 'Other daily',
      creatorMembershipId: fixture.otherMembership,
      frequency: 'DAILY',
    });
    await expectSqlFailure(
      client,
      'cross_home_definition_ref',
      INSERT_INSTANCE_SQL,
      [
        nextId(),
        fixture.home,
        'RECURRING',
        'OPEN',
        'Cross definition',
        '2026-09-13',
        null,
        otherDaily,
        null,
        CREATED,
        CREATED,
      ],
      FOREIGN_KEY_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'manual_with_definition',
      INSERT_INSTANCE_SQL,
      [
        nextId(),
        fixture.home,
        'MANUAL',
        'OPEN',
        'Manual with def',
        null,
        null,
        dailyId,
        null,
        CREATED,
        CREATED,
      ],
      CHECK_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'recurring_without_definition',
      INSERT_INSTANCE_SQL,
      [
        nextId(),
        fixture.home,
        'RECURRING',
        'OPEN',
        'Recurring bare',
        '2026-09-13',
        null,
        null,
        null,
        CREATED,
        CREATED,
      ],
      CHECK_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'recurring_null_date',
      INSERT_INSTANCE_SQL,
      [
        nextId(),
        fixture.home,
        'RECURRING',
        'OPEN',
        'Recurring undated',
        null,
        null,
        dailyId,
        null,
        CREATED,
        CREATED,
      ],
      CHECK_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'open_with_completed_at',
      INSERT_INSTANCE_SQL,
      [
        nextId(),
        fixture.home,
        'MANUAL',
        'OPEN',
        'Open completed',
        null,
        null,
        null,
        COMPLETED,
        CREATED,
        CREATED,
      ],
      CHECK_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'completed_without_completed_at',
      INSERT_INSTANCE_SQL,
      [
        nextId(),
        fixture.home,
        'MANUAL',
        'COMPLETED',
        'Completed missing',
        null,
        null,
        null,
        null,
        CREATED,
        CREATED,
      ],
      CHECK_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'completed_before_created',
      INSERT_INSTANCE_SQL,
      [
        nextId(),
        fixture.home,
        'MANUAL',
        'COMPLETED',
        'Backdated complete',
        null,
        null,
        null,
        new Date('2026-09-12T17:00:00.000Z'),
        CREATED,
        CREATED,
      ],
      CHECK_VIOLATION,
    );
    await insertInstance(client, {
      id: nextId(),
      homeId: fixture.home,
      source: 'RECURRING',
      title: 'First occurrence',
      scheduledFor: '2026-09-20',
      taskDefinitionId: weeklyId,
    });
    await expectSqlFailure(
      client,
      'duplicate_occurrence',
      INSERT_INSTANCE_SQL,
      [
        nextId(),
        fixture.home,
        'RECURRING',
        'OPEN',
        'Duplicate occurrence',
        '2026-09-20',
        null,
        weeklyId,
        null,
        CREATED,
        CREATED,
      ],
      UNIQUE_VIOLATION,
    );

    const badDefinitions: ReadonlyArray<
      [string, Partial<DefinitionInput> & { title: string }]
    > = [
      [
        'daily_weekday',
        { title: 'Daily weekday', frequency: 'DAILY', weekday: 1 },
      ],
      [
        'daily_day_of_month',
        { title: 'Daily month day', frequency: 'DAILY', dayOfMonth: 1 },
      ],
      ['weekly_null_weekday', { title: 'Weekly null', frequency: 'WEEKLY' }],
      [
        'weekly_weekday_low',
        { title: 'Weekly 0', frequency: 'WEEKLY', weekday: 0 },
      ],
      [
        'weekly_weekday_high',
        { title: 'Weekly 8', frequency: 'WEEKLY', weekday: 8 },
      ],
      [
        'weekly_with_month_day',
        {
          title: 'Weekly month day',
          frequency: 'WEEKLY',
          weekday: 2,
          dayOfMonth: 10,
        },
      ],
      ['monthly_null_day', { title: 'Monthly null', frequency: 'MONTHLY' }],
      [
        'monthly_day_low',
        { title: 'Monthly 0', frequency: 'MONTHLY', dayOfMonth: 0 },
      ],
      [
        'monthly_day_high',
        { title: 'Monthly 32', frequency: 'MONTHLY', dayOfMonth: 32 },
      ],
      [
        'monthly_with_weekday',
        {
          title: 'Monthly weekday',
          frequency: 'MONTHLY',
          weekday: 3,
          dayOfMonth: 10,
        },
      ],
      [
        'active_without_next',
        { title: 'Active unsched', frequency: 'DAILY', nextOccurrenceAt: null },
      ],
      [
        'deactivated_with_next',
        {
          title: 'Deactivated scheduled',
          frequency: 'DAILY',
          deactivatedAt: DEACTIVATED,
        },
      ],
      [
        'deactivated_before_created',
        {
          title: 'Deactivated early',
          frequency: 'DAILY',
          nextOccurrenceAt: null,
          deactivatedAt: new Date('2026-09-12T17:00:00.000Z'),
        },
      ],
    ];
    for (const [savepoint, override] of badDefinitions) {
      await expectSqlFailure(
        client,
        savepoint,
        INSERT_DEFINITION_SQL,
        [
          nextId(),
          fixture.home,
          override.title,
          null,
          fixture.creator,
          override.frequency ?? 'DAILY',
          override.weekday ?? null,
          override.dayOfMonth ?? null,
          override.nextOccurrenceAt === undefined
            ? NEXT
            : override.nextOccurrenceAt,
          override.deactivatedAt ?? null,
          CREATED,
          CREATED,
        ],
        CHECK_VIOLATION,
      );
    }

    await insertInstance(client, {
      id: nextId(),
      homeId: fixture.orphanHome,
      source: 'MANUAL',
      title: 'Orphan home task',
    });
    await expectSqlFailure(
      client,
      'delete_referenced_home',
      'DELETE FROM homes WHERE id = $1',
      [fixture.orphanHome],
      [RESTRICT_VIOLATION, FOREIGN_KEY_VIOLATION],
    );
    await expectSqlFailure(
      client,
      'delete_referenced_membership',
      'DELETE FROM memberships WHERE id = $1',
      [fixture.ended],
      [RESTRICT_VIOLATION, FOREIGN_KEY_VIOLATION],
    );
    await expectSqlFailure(
      client,
      'delete_referenced_definition',
      'DELETE FROM task_definitions WHERE id = $1',
      [dailyId],
      [RESTRICT_VIOLATION, FOREIGN_KEY_VIOLATION],
    );

    await client.query('SET LOCAL enable_seqscan = off');
    const openPlan = await client.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (COSTS OFF)
       SELECT id FROM task_instances
       WHERE home_id = $1 AND status = 'OPEN'
       ORDER BY scheduled_for ASC NULLS LAST, created_at, id`,
      [fixture.home],
    );
    assert.match(
      openPlan.rows.map((row) => row['QUERY PLAN']).join('\n'),
      /task_instances_home_open_idx_/,
    );
    const assigneePlan = await client.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (COSTS OFF)
       SELECT id FROM task_instances
       WHERE home_id = $1
         AND assigned_membership_id = $2
         AND status = 'OPEN'
         AND assigned_membership_id IS NOT NULL
       ORDER BY assigned_membership_id, id`,
      [fixture.home, fixture.assigned],
    );
    assert.match(
      assigneePlan.rows.map((row) => row['QUERY PLAN']).join('\n'),
      /task_instances_home_open_assignee_idx_/,
    );
    const duePlan = await client.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (COSTS OFF)
       SELECT id FROM task_definitions
       WHERE deactivated_at IS NULL AND next_occurrence_at <= $1
       ORDER BY next_occurrence_at, id`,
      [NEXT],
    );
    assert.match(
      duePlan.rows.map((row) => row['QUERY PLAN']).join('\n'),
      /task_definitions_worker_due_idx_/,
    );
  } finally {
    await client.query('ROLLBACK');
  }
  console.log('Task SQLSTATE, invariant, and planner probes passed.');
}

async function verifyConcurrentOccurrence(pool: Pool): Promise<void> {
  const setup = await pool.connect();
  const first = await pool.connect();
  const second = await pool.connect();
  const suffix = '02';
  let fixture: Fixture | undefined;
  let definitionId: string | undefined;
  try {
    await setup.query('BEGIN');
    fixture = await createFixture(setup, suffix);
    definitionId = '80000000-0000-7000-8000-000000009000';
    await insertDefinition(setup, {
      id: definitionId,
      homeId: fixture.home,
      title: 'Concurrent daily',
      creatorMembershipId: fixture.creator,
      frequency: 'DAILY',
    });
    await setup.query('COMMIT');
    await first.query('BEGIN');
    await second.query('BEGIN');
    await insertInstance(first, {
      id: '80000000-0000-7000-8000-000000009001',
      homeId: fixture.home,
      source: 'RECURRING',
      title: 'Occurrence A',
      scheduledFor: '2026-09-21',
      taskDefinitionId: definitionId,
    });
    const competing = insertInstance(second, {
      id: '80000000-0000-7000-8000-000000009002',
      homeId: fixture.home,
      source: 'RECURRING',
      title: 'Occurrence B',
      scheduledFor: '2026-09-21',
      taskDefinitionId: definitionId,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await first.query('COMMIT');
    await assert.rejects(
      competing,
      (error: unknown) => sqlState(error) === UNIQUE_VIOLATION,
    );
    await second.query('ROLLBACK');
    const remaining = await setup.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM task_instances
       WHERE task_definition_id = $1 AND scheduled_for = DATE '2026-09-21'`,
      [definitionId],
    );
    assert.equal(remaining.rows[0]?.count, '1');
  } finally {
    await first.query('ROLLBACK').catch(() => undefined);
    await second.query('ROLLBACK').catch(() => undefined);
    first.release();
    second.release();
    if (fixture) {
      await setup.query(
        'DELETE FROM task_instances WHERE home_id IN ($1, $2, $3)',
        [fixture.home, fixture.otherHome, fixture.orphanHome],
      );
      await setup.query(
        'DELETE FROM task_definitions WHERE home_id IN ($1, $2, $3)',
        [fixture.home, fixture.otherHome, fixture.orphanHome],
      );
      await setup.query('DELETE FROM memberships WHERE home_id IN ($1, $2)', [
        fixture.home,
        fixture.otherHome,
      ]);
      await setup.query('DELETE FROM homes WHERE id IN ($1, $2, $3)', [
        fixture.home,
        fixture.otherHome,
        fixture.orphanHome,
      ]);
      await setup.query('DELETE FROM users WHERE id IN ($1, $2)', [
        fixture.userA,
        fixture.userB,
      ]);
    }
    setup.release();
  }
  console.log('Concurrent recurrence uniqueness defense passed.');
}

export async function verifyTaskSchema(databaseUrl: string): Promise<void> {
  assertSafeTestDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    const client = await pool.connect();
    try {
      await verifyCatalog(client);
      await verifyBehavior(client);
    } finally {
      client.release();
    }
    await verifyConcurrentOccurrence(pool);
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  await verifyTaskSchema(resolveTestDatabaseUrl());
}
