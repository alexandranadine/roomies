#!/usr/bin/env node

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { Pool, type PoolClient } from 'pg';
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

const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';

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
  expectedCode: string,
): Promise<void> {
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    await client.query(sql, [...params]);
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    assert.equal(sqlState(error), expectedCode, savepoint);
    return;
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  assert.fail(`${savepoint}: expected SQLSTATE ${expectedCode}`);
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
): Promise<
  Map<string, { conname: string; contype: string; definition: string }>
> {
  const result = await client.query<{
    conname: string;
    contype: string;
    definition: string;
  }>(
    `SELECT conname, contype, pg_get_constraintdef(oid, true) AS definition
     FROM pg_catalog.pg_constraint
     WHERE conrelid = $1::regclass
     ORDER BY conname`,
    [`public.${table}`],
  );
  return new Map(result.rows.map((row) => [row.conname, row]));
}

async function verifyCatalog(client: PoolClient): Promise<void> {
  const membershipColumns = await tableColumns(client, 'memberships');
  const endedBy = membershipColumns.get('ended_by_membership_id');
  assert.ok(endedBy);
  assert.equal(endedBy.data_type, 'uuid');
  assert.equal(endedBy.udt_name, 'uuid');
  assert.equal(endedBy.is_nullable, 'YES');
  assert.equal(endedBy.column_default, null);
  assert.equal(membershipColumns.has('ended_by_user_id'), false);

  const membershipConstraints = await constraintMap(client, 'memberships');
  assert.equal(
    membershipConstraints.get('memberships_end_actor_check')?.contype,
    'c',
  );
  assert.match(
    membershipConstraints.get('memberships_end_actor_check')?.definition ?? '',
    /\(\(ended_at IS NULL\) = \(ended_by_membership_id IS NULL\)\)/,
  );
  assert.match(
    membershipConstraints.get('memberships_ended_by_home_membership_fkey')
      ?.definition ?? '',
    /FOREIGN KEY \(home_id, ended_by_membership_id\).*memberships\(home_id, id\).*ON UPDATE RESTRICT ON DELETE RESTRICT/i,
  );

  const transitionColumns = await tableColumns(
    client,
    'membership_role_transitions',
  );
  assert.deepEqual(
    [...transitionColumns.keys()],
    [
      'actor_membership_id',
      'changed_at',
      'created_at',
      'home_id',
      'id',
      'membership_id',
    ],
  );
  for (const name of [
    'id',
    'home_id',
    'membership_id',
    'actor_membership_id',
    'changed_at',
    'created_at',
  ]) {
    const column = transitionColumns.get(name);
    assert.ok(column, name);
    assert.equal(column.is_nullable, 'NO', name);
    assert.equal(column.column_default, null, name);
  }
  assert.equal(transitionColumns.get('id')?.udt_name, 'uuid');
  assert.equal(transitionColumns.has('user_id'), false);
  assert.equal(transitionColumns.has('old_role'), false);
  assert.equal(transitionColumns.has('new_role'), false);
  assert.equal(transitionColumns.has('previous_role'), false);
  assert.equal(transitionColumns.has('display'), false);

  const transitionConstraints = await constraintMap(
    client,
    'membership_role_transitions',
  );
  assert.equal(
    transitionConstraints.get('membership_role_transitions_pkey')?.contype,
    'p',
  );
  assert.match(
    transitionConstraints.get('membership_role_transitions_pkey')?.definition ??
      '',
    /PRIMARY KEY \(id\)/,
  );
  assert.match(
    transitionConstraints.get(
      'membership_role_transitions_subject_home_membership_fkey',
    )?.definition ?? '',
    /FOREIGN KEY \(home_id, membership_id\).*memberships\(home_id, id\).*ON UPDATE RESTRICT ON DELETE RESTRICT/i,
  );
  assert.match(
    transitionConstraints.get(
      'membership_role_transitions_actor_home_membership_fkey',
    )?.definition ?? '',
    /FOREIGN KEY \(home_id, actor_membership_id\).*memberships\(home_id, id\).*ON UPDATE RESTRICT ON DELETE RESTRICT/i,
  );

  console.log('Membership tenure actor catalog verification passed.');
}

async function verifyBehavior(client: PoolClient): Promise<void> {
  await client.query('BEGIN');
  try {
    const userA = '10000000-0000-4000-8000-0000000000a1';
    const userB = '20000000-0000-4000-8000-0000000000b2';
    const home = '30000000-0000-4000-8000-0000000000c3';
    const otherHome = '40000000-0000-4000-8000-0000000000d4';
    const membershipA = '50000000-0000-4000-8000-0000000000e5';
    const membershipB = '60000000-0000-4000-8000-0000000000f6';
    const otherMembership = '70000000-0000-4000-8000-0000000000a7';
    const now = new Date('2026-09-13T12:00:00.000Z');

    await client.query(
      'INSERT INTO users (id, updated_at) VALUES ($1, $3), ($2, $3)',
      [userA, userB, now],
    );
    await client.query(
      `INSERT INTO homes (id, name, timezone, updated_at)
       VALUES ($1, 'Actor home', 'UTC', $3), ($2, 'Other home', 'UTC', $3)`,
      [home, otherHome, now],
    );
    await client.query(
      `INSERT INTO memberships (id, home_id, user_id, role, ended_at, ended_by_membership_id)
       VALUES ($1, $3, $5, 'ADMIN', NULL, NULL),
              ($2, $3, $6, 'ROOMMATE', NULL, NULL),
              ($4, $7, $6, 'ADMIN', NULL, NULL)`,
      [
        membershipA,
        membershipB,
        home,
        otherMembership,
        userA,
        userB,
        otherHome,
      ],
    );

    await expectSqlFailure(
      client,
      'ended_without_actor',
      `UPDATE memberships SET ended_at = $2 WHERE id = $1`,
      [membershipB, now],
      CHECK_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'actor_without_ended',
      `UPDATE memberships SET ended_by_membership_id = $2 WHERE id = $1`,
      [membershipB, membershipA],
      CHECK_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'cross_home_end_actor',
      `UPDATE memberships
       SET ended_at = $2, ended_by_membership_id = $3
       WHERE id = $1`,
      [membershipB, now, otherMembership],
      FOREIGN_KEY_VIOLATION,
    );

    await client.query(
      `UPDATE memberships
       SET ended_at = $2, ended_by_membership_id = $3
       WHERE id = $1`,
      [membershipB, now, membershipA],
    );

    await expectSqlFailure(
      client,
      'transition_cross_home_subject',
      `INSERT INTO membership_role_transitions (
         id, home_id, membership_id, actor_membership_id, changed_at, created_at
       ) VALUES ($1, $2, $3, $4, $5, $5)`,
      [
        '80000000-0000-4000-8000-0000000000b8',
        home,
        otherMembership,
        membershipA,
        now,
      ],
      FOREIGN_KEY_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'transition_cross_home_actor',
      `INSERT INTO membership_role_transitions (
         id, home_id, membership_id, actor_membership_id, changed_at, created_at
       ) VALUES ($1, $2, $3, $4, $5, $5)`,
      [
        '90000000-0000-4000-8000-0000000000c9',
        home,
        membershipA,
        otherMembership,
        now,
      ],
      FOREIGN_KEY_VIOLATION,
    );

    await client.query(
      `INSERT INTO membership_role_transitions (
         id, home_id, membership_id, actor_membership_id, changed_at, created_at
       ) VALUES ($1, $2, $3, $4, $5, $5), ($6, $2, $3, $4, $5, $5)`,
      [
        'a0000000-0000-4000-8000-0000000000d0',
        home,
        membershipA,
        membershipA,
        now,
        'b0000000-0000-4000-8000-0000000000e1',
      ],
    );

    const count = await client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM membership_role_transitions WHERE home_id = $1',
      [home],
    );
    assert.equal(count.rows[0]?.count, '2');
  } finally {
    await client.query('ROLLBACK');
  }
  console.log('Membership tenure actor behavior verification passed.');
}

export async function verifyMembershipSchema(
  databaseUrl: string,
): Promise<void> {
  const parsed = assertSafeTestDatabase(databaseUrl);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
  });
  const client = await pool.connect();
  try {
    console.log(
      `Membership schema target: ${parsed.hostname}:${parsed.port}/${parsed.database}`,
    );
    await verifyCatalog(client);
    await verifyBehavior(client);
  } finally {
    client.release();
    await pool.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await verifyMembershipSchema(resolveTestDatabaseUrl());
}
