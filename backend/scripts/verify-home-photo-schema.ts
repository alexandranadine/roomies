#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
const UNIQUE_VIOLATION = '23505';

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

async function verifyCatalog(client: PoolClient): Promise<void> {
  const columns = await client.query<ColumnRow>(
    `SELECT column_name, data_type, udt_name, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'homes'
     ORDER BY column_name`,
  );
  const byName = new Map(columns.rows.map((row) => [row.column_name, row]));
  const photo = byName.get('photo_object_key');
  assert.ok(photo, 'homes.photo_object_key exists');
  assert.equal(photo.data_type, 'text');
  assert.equal(photo.udt_name, 'text');
  assert.equal(photo.is_nullable, 'YES');
  assert.equal(photo.column_default, null);

  for (const absent of [
    'photo_uploader',
    'photo_content_type',
    'photo_width',
    'photo_height',
    'photo_checksum',
    'photo_bucket',
    'photo_account',
    'media_id',
  ]) {
    assert.equal(byName.has(absent), false, absent);
  }

  const constraints = await client.query<{
    conname: string;
    contype: string;
    definition: string;
  }>(
    `SELECT conname, contype, pg_get_constraintdef(oid, true) AS definition
     FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.homes'::regclass
     ORDER BY conname`,
  );
  const constraintByName = new Map(
    constraints.rows.map((row) => [row.conname, row]),
  );
  const check = constraintByName.get('homes_photo_object_key_canonical_check');
  assert.ok(check, 'homes_photo_object_key_canonical_check exists');
  assert.equal(check.contype, 'c');
  assert.match(check.definition, /photo_object_key IS NULL/i);
  assert.match(
    check.definition,
    /homes\/\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\/photo\/\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}/,
  );
  assert.match(check.definition, /webp/);

  const indexes = await client.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef
     FROM pg_catalog.pg_indexes
     WHERE schemaname = 'public' AND tablename = 'homes'`,
  );
  const uniquePhoto = indexes.rows.find((row) =>
    row.indexname.startsWith('homes_photo_object_key_uidx'),
  );
  assert.ok(uniquePhoto, 'unique photo_object_key index exists');
  assert.match(uniquePhoto.indexdef, /UNIQUE INDEX/i);
  assert.match(uniquePhoto.indexdef, /photo_object_key/);
  assert.equal(
    indexes.rows.filter((row) => row.indexdef.includes('photo_object_key'))
      .length,
    1,
    'no additional photo lookup index',
  );

  const mediaTables = await client.query<{ tablename: string }>(
    `SELECT tablename
     FROM pg_catalog.pg_tables
     WHERE schemaname = 'public'
       AND tablename IN ('media', 'home_media', 'home_photos', 'photos')`,
  );
  assert.equal(mediaTables.rows.length, 0);

  console.log('Home photo pointer catalog verification passed.');
}

async function verifyRuntime(client: PoolClient): Promise<void> {
  const homeA = randomUUID();
  const homeB = randomUUID();
  const generationA = randomUUID();
  const generationB = randomUUID();
  const canonicalA = `homes/${homeA}/photo/${generationA}.webp`;
  const canonicalB = `homes/${homeB}/photo/${generationB}.webp`;

  await client.query('BEGIN');
  try {
    await client.query(
      `INSERT INTO homes (id, name, timezone, updated_at)
       VALUES ($1, 'Photo A', 'UTC', NOW()), ($2, 'Photo B', 'UTC', NOW())`,
      [homeA, homeB],
    );

    await client.query(`UPDATE homes SET photo_object_key = $2 WHERE id = $1`, [
      homeA,
      canonicalA,
    ]);
    await client.query(`UPDATE homes SET photo_object_key = $2 WHERE id = $1`, [
      homeB,
      canonicalB,
    ]);

    await expectSqlFailure(
      client,
      'sp_tmp_prefix',
      `UPDATE homes SET photo_object_key = $2 WHERE id = $1`,
      [homeA, `tmp/${canonicalA}`],
      CHECK_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'sp_uppercase',
      `UPDATE homes SET photo_object_key = $2 WHERE id = $1`,
      [homeA, canonicalA.toUpperCase()],
      CHECK_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'sp_extension',
      `UPDATE homes SET photo_object_key = $2 WHERE id = $1`,
      [homeA, canonicalA.replace('.webp', '.png')],
      CHECK_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'sp_unique',
      `UPDATE homes SET photo_object_key = $2 WHERE id = $1`,
      [homeB, canonicalA],
      UNIQUE_VIOLATION,
    );

    await client.query(
      `UPDATE homes SET photo_object_key = NULL WHERE id = ANY($1::uuid[])`,
      [[homeA, homeB]],
    );
    const nulls = await client.query<{ photo_object_key: string | null }>(
      `SELECT photo_object_key FROM homes WHERE id = ANY($1::uuid[])`,
      [[homeA, homeB]],
    );
    assert.equal(nulls.rows.length, 2);
    assert.ok(nulls.rows.every((row) => row.photo_object_key === null));
  } finally {
    await client.query('ROLLBACK');
  }
  console.log('Home photo pointer runtime verification passed.');
}

export async function verifyHomePhotoSchema(
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
      `Home photo schema target: ${parsed.hostname}:${parsed.port}/${parsed.database}`,
    );
    await verifyCatalog(client);
    await verifyRuntime(client);
  } finally {
    client.release();
    await pool.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await verifyHomePhotoSchema(resolveTestDatabaseUrl());
}
