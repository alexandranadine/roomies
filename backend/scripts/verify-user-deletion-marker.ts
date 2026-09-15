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

type IndexRow = {
  indexname: string;
};

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

async function verifyCatalog(client: PoolClient): Promise<void> {
  const userColumns = await tableColumns(client, 'users');
  assert.deepEqual(
    [...userColumns.keys()],
    ['created_at', 'deleted_at', 'id', 'updated_at'],
  );

  const deletedAt = userColumns.get('deleted_at');
  assert.ok(deletedAt);
  assert.equal(deletedAt.data_type, 'timestamp with time zone');
  assert.equal(deletedAt.udt_name, 'timestamptz');
  assert.equal(deletedAt.is_nullable, 'YES');
  assert.equal(deletedAt.column_default, null);

  assert.equal(userColumns.has('status'), false);
  assert.equal(userColumns.has('deleted_name'), false);
  assert.equal(userColumns.has('deleted_email'), false);

  const indexes = await client.query<IndexRow>(
    `SELECT indexname
     FROM pg_catalog.pg_indexes
     WHERE schemaname = 'public' AND tablename = 'users'`,
  );
  assert.deepEqual(indexes.rows.map((row) => row.indexname).sort(), [
    'users_pkey',
  ]);

  const tables = await client.query<{ tablename: string }>(
    `SELECT tablename
     FROM pg_catalog.pg_tables
     WHERE schemaname = 'public'
       AND tablename IN ('user_deletion_requests', 'user_recovery', 'user_tombstones')`,
  );
  assert.equal(tables.rows.length, 0);

  console.log('Canonical User deletion marker catalog verification passed.');
}

export async function verifyUserDeletionMarker(
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
      `User deletion marker target: ${parsed.hostname}:${parsed.port}/${parsed.database}`,
    );
    await verifyCatalog(client);
  } finally {
    client.release();
    await pool.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await verifyUserDeletionMarker(resolveTestDatabaseUrl());
}
