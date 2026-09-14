#!/usr/bin/env node

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { INSERT_NOTIFICATION_SQL } from '../src/domains/notifications/index.js';
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
  users: readonly [string, string, string];
  homes: readonly [string, string];
  memberships: readonly [string, string, string];
};

const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';
const NOT_NULL_VIOLATION = '23502';
const RESTRICT_VIOLATION = '23001';
const CREATED = new Date('2026-09-13T12:00:00.000Z');
const OCCURRED = new Date('2026-09-13T11:00:00.000Z');

const FORBIDDEN_COLUMNS = [
  'user_id',
  'metadata',
  'payload',
  'title',
  'details',
  'audience',
  'name',
  'email',
  'role',
  'revoked_at',
  'priority',
  'expiry',
  'channel',
  'delivery_state',
];

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

async function verifyCatalog(client: PoolClient): Promise<void> {
  const tables = await client.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'notifications'`,
  );
  assert.deepEqual(
    tables.rows.map((row) => row.table_name),
    ['notifications'],
  );

  const nativeEnums = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM pg_catalog.pg_type
     WHERE typnamespace = 'public'::regnamespace
       AND typtype = 'e'
       AND typname LIKE 'notification%'`,
  );
  assert.equal(nativeEnums.rows[0]?.count, '0');

  const notifications = await tableColumns(client, 'notifications');
  assert.deepEqual(
    [...notifications.keys()],
    [
      'actor_membership_id',
      'created_at',
      'home_id',
      'id',
      'kind',
      'occurred_at',
      'read_at',
      'recipient_membership_id',
      'source_entity_id',
      'source_entity_type',
      'source_outbox_event_id',
    ],
  );
  assertColumn(notifications, 'id', 'uuid', 'NO', null);
  assertColumn(notifications, 'home_id', 'uuid', 'NO', null);
  assertColumn(notifications, 'recipient_membership_id', 'uuid', 'NO', null);
  assertColumn(notifications, 'source_outbox_event_id', 'uuid', 'NO', null);
  assertColumn(notifications, 'kind', 'text', 'NO', null);
  assertColumn(notifications, 'source_entity_type', 'text', 'NO', null);
  assertColumn(notifications, 'source_entity_id', 'uuid', 'NO', null);
  assertColumn(notifications, 'actor_membership_id', 'uuid', 'YES', null);
  assertColumn(notifications, 'occurred_at', 'timestamptz', 'NO', null);
  assertColumn(notifications, 'created_at', 'timestamptz', 'NO', null);
  assertColumn(notifications, 'read_at', 'timestamptz', 'YES', null);
  for (const name of FORBIDDEN_COLUMNS) {
    assert.equal(notifications.has(name), false, `forbidden column ${name}`);
  }

  const constraints = await constraintMap(client, 'notifications');
  assert.deepEqual(
    [...constraints.keys()],
    [
      'notifications_actor_home_membership_fkey',
      'notifications_actor_membership_fkey',
      'notifications_home_id_fkey',
      'notifications_kind_check_c456c50a',
      'notifications_kind_source_check',
      'notifications_pkey',
      'notifications_recipient_home_membership_fkey',
      'notifications_source_entity_type_check_0ee9d6e1',
    ],
  );
  assert.match(
    constraints.get('notifications_kind_check_c456c50a')?.definition ?? '',
    /kind = ANY.*MEMBERSHIP_ROLE_CHANGED.*ASSIGNED_TASK_COMPLETED.*CREATED_SUPPLY_OBTAINED.*PRIVATE_MAINTENANCE_CREATED.*PRIVATE_MAINTENANCE_RESOLVED/s,
  );
  assert.match(
    constraints.get('notifications_source_entity_type_check_0ee9d6e1')
      ?.definition ?? '',
    /source_entity_type = ANY.*MEMBERSHIP.*TASK.*SUPPLY.*MAINTENANCE/s,
  );
  assert.match(
    constraints.get('notifications_kind_source_check')?.definition ?? '',
    /MEMBERSHIP_ROLE_CHANGED.*MEMBERSHIP.*ASSIGNED_TASK_COMPLETED.*TASK.*CREATED_SUPPLY_OBTAINED.*SUPPLY.*PRIVATE_MAINTENANCE_CREATED.*MAINTENANCE.*PRIVATE_MAINTENANCE_RESOLVED.*MAINTENANCE/s,
  );
  assert.equal(constraints.get('notifications_pkey')?.contype, 'p');
  assert.match(
    constraints.get('notifications_home_id_fkey')?.definition ?? '',
    /FOREIGN KEY \(home_id\).*homes\(id\).*ON UPDATE RESTRICT ON DELETE CASCADE/i,
  );
  assert.match(
    constraints.get('notifications_recipient_home_membership_fkey')
      ?.definition ?? '',
    /FOREIGN KEY \(home_id, recipient_membership_id\).*memberships\(home_id, id\).*ON UPDATE RESTRICT ON DELETE CASCADE/i,
  );
  assert.match(
    constraints.get('notifications_actor_membership_fkey')?.definition ?? '',
    /FOREIGN KEY \(actor_membership_id\).*memberships\(id\).*ON UPDATE RESTRICT ON DELETE SET NULL/i,
  );
  assert.match(
    constraints.get('notifications_actor_home_membership_fkey')?.definition ??
      '',
    /FOREIGN KEY \(home_id, actor_membership_id\).*memberships\(home_id, id\).*ON UPDATE RESTRICT ON DELETE RESTRICT/i,
  );

  const outboxFks = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.notifications'::regclass
       AND contype = 'f'
       AND confrelid = 'public.outbox_events'::regclass`,
  );
  assert.equal(outboxFks.rows[0]?.count, '0');

  const sourceFks = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.notifications'::regclass
       AND contype = 'f'
       AND confrelid IN (
         'public.task_instances'::regclass,
         'public.supply_entries'::regclass,
         'public.maintenance_entries'::regclass,
         'public.activities'::regclass
       )`,
  );
  assert.equal(sourceFks.rows[0]?.count, '0');

  const indexes = await indexMap(client, 'notifications');
  assert.deepEqual(
    [...indexes.keys()],
    [
      'notifications_actor_membership_id_idx_a5b20b69',
      'notifications_home_id_actor_membership_id_idx_59ee34c2',
      'notifications_home_id_idx_f881d5c1',
      'notifications_home_id_recipient_membership_id_idx_d6e4e47a',
      'notifications_home_recipient_occurred_idx_97c4c8ff',
      'notifications_home_recipient_unread_idx_537467f2',
      'notifications_pkey',
      'notifications_retention_idx_e92395ef',
      'notifications_source_erasure_idx_f94ef0c8',
      'notifications_source_recipient_kind_key_15fab2f3',
    ],
  );
  assert.match(
    indexes.get('notifications_source_recipient_kind_key_15fab2f3') ?? '',
    /UNIQUE INDEX.*\(source_outbox_event_id, recipient_membership_id, kind\)/i,
  );
  assert.match(
    indexes.get('notifications_home_recipient_occurred_idx_97c4c8ff') ?? '',
    /\(home_id, recipient_membership_id, occurred_at, id\)/i,
  );
  assert.match(
    indexes.get('notifications_source_erasure_idx_f94ef0c8') ?? '',
    /\(home_id, source_entity_type, source_entity_id\)/i,
  );
  assert.match(
    indexes.get('notifications_retention_idx_e92395ef') ?? '',
    /\(occurred_at, id\)/i,
  );
  assert.match(
    indexes.get('notifications_home_recipient_unread_idx_537467f2') ?? '',
    /\(home_id, recipient_membership_id, created_at, id\).*WHERE.*read_at IS NULL/is,
  );

  const triggers = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM pg_catalog.pg_trigger
     WHERE tgrelid = 'public.notifications'::regclass
       AND NOT tgisinternal`,
  );
  assert.equal(triggers.rows[0]?.count, '0');
  console.log('Notification catalog verification passed.');
}

function fixtureIds(suffix: string): Fixture {
  return {
    users: [
      `11000000-0000-4000-8000-0000000000${suffix}`,
      `12000000-0000-4000-8000-0000000000${suffix}`,
      `13000000-0000-4000-8000-0000000000${suffix}`,
    ],
    homes: [
      `21000000-0000-4000-8000-0000000000${suffix}`,
      `22000000-0000-4000-8000-0000000000${suffix}`,
    ],
    memberships: [
      `31000000-0000-4000-8000-0000000000${suffix}`,
      `32000000-0000-4000-8000-0000000000${suffix}`,
      `33000000-0000-4000-8000-0000000000${suffix}`,
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
     VALUES ($1, now()), ($2, now()), ($3, now())`,
    [...fixture.users],
  );
  await client.query(
    `INSERT INTO homes (id, name, timezone, updated_at)
     VALUES ($1, 'Notification verification', 'UTC', now()),
            ($2, 'Other notification home', 'UTC', now())`,
    [...fixture.homes],
  );
  await client.query(
    `INSERT INTO memberships (id, home_id, user_id, role, ended_at, ended_by_membership_id)
     VALUES ($1, $4, $6, 'ADMIN', NULL, NULL),
            ($2, $4, $7, 'ROOMMATE', NULL, NULL),
            ($3, $5, $8, 'ADMIN', NULL, NULL)`,
    [
      fixture.memberships[0],
      fixture.memberships[1],
      fixture.memberships[2],
      fixture.homes[0],
      fixture.homes[1],
      fixture.users[0],
      fixture.users[1],
      fixture.users[2],
    ],
  );
  return fixture;
}

async function cleanupFixture(
  client: PoolClient,
  fixture: Fixture,
): Promise<void> {
  await client.query(
    'DELETE FROM notifications WHERE home_id = ANY($1::uuid[])',
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

function notificationParams(
  id: string,
  fixture: Fixture,
  overrides: {
    homeId?: string;
    recipientMembershipId?: string;
    sourceOutboxEventId?: string;
    kind?: string;
    sourceEntityType?: string;
    sourceEntityId?: string;
    actorMembershipId?: string | null;
    occurredAt?: Date;
    createdAt?: Date;
    readAt?: Date | null;
  } = {},
): unknown[] {
  return [
    id,
    overrides.homeId ?? fixture.homes[0],
    overrides.recipientMembershipId === undefined
      ? fixture.memberships[0]
      : overrides.recipientMembershipId,
    overrides.sourceOutboxEventId ?? id,
    overrides.kind ?? 'PRIVATE_MAINTENANCE_CREATED',
    overrides.sourceEntityType ?? 'MAINTENANCE',
    overrides.sourceEntityId ?? id,
    overrides.actorMembershipId === undefined
      ? fixture.memberships[1]
      : overrides.actorMembershipId,
    overrides.occurredAt ?? OCCURRED,
    overrides.createdAt ?? CREATED,
    overrides.readAt === undefined ? null : overrides.readAt,
  ];
}

async function verifyBehavior(pool: Pool): Promise<void> {
  const client = await pool.connect();
  let fixture: Fixture | undefined;
  try {
    fixture = await createFixture(client, '71');
    let serial = 1;
    const nextId = () =>
      `71000000-0000-7000-8000-${String(serial++).padStart(12, '0')}`;

    await client.query('BEGIN');
    const createdLater = new Date('2026-09-14T12:00:00.000Z');
    await client.query(
      INSERT_NOTIFICATION_SQL,
      notificationParams(nextId(), fixture, {
        createdAt: createdLater,
        occurredAt: OCCURRED,
      }),
    );

    const duplicateEvent = nextId();
    const duplicateRecipient = fixture.memberships[0];
    await client.query(
      INSERT_NOTIFICATION_SQL,
      notificationParams(nextId(), fixture, {
        sourceOutboxEventId: duplicateEvent,
        recipientMembershipId: duplicateRecipient,
        kind: 'ASSIGNED_TASK_COMPLETED',
        sourceEntityType: 'TASK',
      }),
    );
    await expectSqlFailure(
      client,
      'duplicate_source_recipient_kind',
      INSERT_NOTIFICATION_SQL,
      notificationParams(nextId(), fixture, {
        sourceOutboxEventId: duplicateEvent,
        recipientMembershipId: duplicateRecipient,
        kind: 'ASSIGNED_TASK_COMPLETED',
        sourceEntityType: 'TASK',
      }),
      UNIQUE_VIOLATION,
    );

    await expectSqlFailure(
      client,
      'invalid_kind',
      INSERT_NOTIFICATION_SQL,
      notificationParams(nextId(), fixture, { kind: 'HOUSE_PULSE' }),
      CHECK_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'invalid_source_type',
      INSERT_NOTIFICATION_SQL,
      notificationParams(nextId(), fixture, {
        sourceEntityType: 'INVITATION',
      }),
      CHECK_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'kind_source_mismatch',
      INSERT_NOTIFICATION_SQL,
      notificationParams(nextId(), fixture, {
        kind: 'MEMBERSHIP_ROLE_CHANGED',
        sourceEntityType: 'TASK',
      }),
      CHECK_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'recipient_cross_home',
      INSERT_NOTIFICATION_SQL,
      notificationParams(nextId(), fixture, {
        recipientMembershipId: fixture.memberships[2],
      }),
      FOREIGN_KEY_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'actor_cross_home',
      INSERT_NOTIFICATION_SQL,
      notificationParams(nextId(), fixture, {
        actorMembershipId: fixture.memberships[2],
      }),
      FOREIGN_KEY_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'null_home',
      `INSERT INTO notifications (
         id, home_id, recipient_membership_id, source_outbox_event_id,
         kind, source_entity_type, source_entity_id, occurred_at, created_at
       ) VALUES (
         $1::uuid, NULL, $2::uuid, $1::uuid,
         'ASSIGNED_TASK_COMPLETED', 'TASK', $1::uuid,
         $3::timestamptz, $4::timestamptz
       )`,
      [nextId(), fixture.memberships[0], OCCURRED, CREATED],
      NOT_NULL_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'null_recipient',
      INSERT_NOTIFICATION_SQL,
      notificationParams(nextId(), fixture, {
        recipientMembershipId: null as unknown as string,
      }),
      NOT_NULL_VIOLATION,
    );

    const nullableActorId = nextId();
    await client.query(
      INSERT_NOTIFICATION_SQL,
      notificationParams(nullableActorId, fixture, {
        actorMembershipId: null,
        kind: 'CREATED_SUPPLY_OBTAINED',
        sourceEntityType: 'SUPPLY',
      }),
    );

    const recipientCascadeId = nextId();
    await client.query(
      INSERT_NOTIFICATION_SQL,
      notificationParams(recipientCascadeId, fixture, {
        recipientMembershipId: fixture.memberships[1],
        actorMembershipId: fixture.memberships[0],
        kind: 'MEMBERSHIP_ROLE_CHANGED',
        sourceEntityType: 'MEMBERSHIP',
      }),
    );
    const actorSurviveId = nextId();
    await client.query(
      INSERT_NOTIFICATION_SQL,
      notificationParams(actorSurviveId, fixture, {
        recipientMembershipId: fixture.memberships[0],
        actorMembershipId: fixture.memberships[1],
        kind: 'ASSIGNED_TASK_COMPLETED',
        sourceEntityType: 'TASK',
      }),
    );

    await expectSqlFailure(
      client,
      'delete_home_while_memberships',
      'DELETE FROM homes WHERE id = $1',
      [fixture.homes[0]],
      [RESTRICT_VIOLATION, FOREIGN_KEY_VIOLATION],
    );

    await client.query('DELETE FROM memberships WHERE id = $1', [
      fixture.memberships[1],
    ]);
    const afterActorDelete = await client.query<{
      id: string;
      actor_membership_id: string | null;
    }>(
      'SELECT id, actor_membership_id FROM notifications WHERE id = ANY($1::uuid[])',
      [[recipientCascadeId, actorSurviveId]],
    );
    assert.equal(
      afterActorDelete.rows.some((row) => row.id === recipientCascadeId),
      false,
    );
    const surviving = afterActorDelete.rows.find(
      (row) => row.id === actorSurviveId,
    );
    assert.equal(surviving?.actor_membership_id, null);
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
  console.log('Notification constraint and same-Home probes passed.');
}

export async function verifyNotificationSchema(
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
  await verifyNotificationSchema(resolveTestDatabaseUrl());
}
