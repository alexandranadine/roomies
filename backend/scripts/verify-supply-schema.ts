#!/usr/bin/env node

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import {
  createSupplyRepository,
  INSERT_SUPPLY_CLAIM_SQL,
  INSERT_SUPPLY_ENTRY_SQL,
} from '../src/domains/supplies/index.js';
import {
  assertSafeTestDatabase,
  resolveTestDatabaseUrl,
} from '../src/platform/persistence/test-database.js';
import type { TransactionContext } from '../src/platform/persistence/transaction.js';

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
  memberships: readonly [string, string, string, string];
};

const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const RESTRICT_VIOLATION = '23001';
const UNIQUE_VIOLATION = '23505';
const CREATED = new Date('2026-09-13T05:00:00.000Z');
const CLAIMED = new Date('2026-09-13T06:00:00.000Z');
const RELEASED = new Date('2026-09-13T07:00:00.000Z');
const TERMINAL = new Date('2026-09-13T08:00:00.000Z');

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
  const supplyTables = await client.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name LIKE 'supply_%'
     ORDER BY table_name`,
  );
  assert.deepEqual(
    supplyTables.rows.map((row) => row.table_name),
    ['supply_claims', 'supply_entries'],
  );

  const nativeEnums = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM pg_catalog.pg_type
     WHERE typnamespace = 'public'::regnamespace
       AND typtype = 'e'
       AND typname LIKE 'supply%'`,
  );
  assert.equal(nativeEnums.rows[0]?.count, '0');

  const entries = await tableColumns(client, 'supply_entries');
  assert.deepEqual(
    [...entries.keys()],
    [
      'canceled_at',
      'created_at',
      'created_by_membership_id',
      'home_id',
      'id',
      'obtained_at',
      'status',
      'title',
      'updated_at',
    ],
  );
  assertColumn(entries, 'id', 'uuid', 'NO', null);
  assertColumn(entries, 'home_id', 'uuid', 'NO', null);
  assertColumn(entries, 'title', 'text', 'NO', null);
  assertColumn(entries, 'status', 'text', 'NO', "'OPEN'::text");
  assertColumn(entries, 'created_by_membership_id', 'uuid', 'NO', null);
  assertColumn(entries, 'obtained_at', 'timestamptz', 'YES', null);
  assertColumn(entries, 'canceled_at', 'timestamptz', 'YES', null);
  assertColumn(entries, 'created_at', 'timestamptz', 'NO', 'now()');
  assertColumn(entries, 'updated_at', 'timestamptz', 'NO', null);

  const claims = await tableColumns(client, 'supply_claims');
  assert.deepEqual(
    [...claims.keys()],
    [
      'claimant_membership_id',
      'claimed_at',
      'created_at',
      'home_id',
      'id',
      'release_reason',
      'released_at',
      'supply_entry_id',
      'updated_at',
    ],
  );
  assertColumn(claims, 'id', 'uuid', 'NO', null);
  assertColumn(claims, 'home_id', 'uuid', 'NO', null);
  assertColumn(claims, 'supply_entry_id', 'uuid', 'NO', null);
  assertColumn(claims, 'claimant_membership_id', 'uuid', 'NO', null);
  assertColumn(claims, 'claimed_at', 'timestamptz', 'NO', null);
  assertColumn(claims, 'released_at', 'timestamptz', 'YES', null);
  assertColumn(claims, 'release_reason', 'text', 'YES', null);
  assertColumn(claims, 'created_at', 'timestamptz', 'NO', 'now()');
  assertColumn(claims, 'updated_at', 'timestamptz', 'NO', null);

  const entryConstraints = await constraintMap(client, 'supply_entries');
  assert.deepEqual(
    [...entryConstraints.keys()],
    [
      'supply_entries_creator_home_membership_fkey',
      'supply_entries_home_id_fkey',
      'supply_entries_lifecycle_check',
      'supply_entries_pkey',
      'supply_entries_status_check_cbe78413',
      'supply_entries_terminal_time_check',
    ],
  );
  assert.equal(
    entryConstraints.get('supply_entries_lifecycle_check')?.contype,
    'c',
  );
  assert.match(
    entryConstraints.get('supply_entries_lifecycle_check')?.definition ?? '',
    /status = 'OPEN'.*obtained_at IS NULL.*canceled_at IS NULL.*status = 'OBTAINED'.*obtained_at IS NOT NULL.*canceled_at IS NULL.*status = 'CANCELED'.*obtained_at IS NULL.*canceled_at IS NOT NULL/s,
  );
  assert.equal(
    entryConstraints.get('supply_entries_status_check_cbe78413')?.contype,
    'c',
  );
  assert.match(
    entryConstraints.get('supply_entries_status_check_cbe78413')?.definition ??
      '',
    /status = ANY.*OPEN.*OBTAINED.*CANCELED/s,
  );
  assert.equal(
    entryConstraints.get('supply_entries_terminal_time_check')?.contype,
    'c',
  );
  assert.match(
    entryConstraints.get('supply_entries_terminal_time_check')?.definition ??
      '',
    /obtained_at IS NULL OR obtained_at >= created_at.*canceled_at IS NULL OR canceled_at >= created_at/s,
  );
  assertRestrictForeignKey(
    entryConstraints,
    'supply_entries_home_id_fkey',
    /FOREIGN KEY \(home_id\).*homes\(id\)/i,
  );
  assertRestrictForeignKey(
    entryConstraints,
    'supply_entries_creator_home_membership_fkey',
    /FOREIGN KEY \(home_id, created_by_membership_id\).*memberships\(home_id, id\)/i,
  );

  const claimConstraints = await constraintMap(client, 'supply_claims');
  assert.deepEqual(
    [...claimConstraints.keys()],
    [
      'supply_claims_claimant_home_membership_fkey',
      'supply_claims_entry_home_fkey',
      'supply_claims_home_id_fkey',
      'supply_claims_pkey',
      'supply_claims_release_completeness_check',
      'supply_claims_release_reason_check_d17b2d97',
      'supply_claims_released_time_check',
    ],
  );
  assert.equal(
    claimConstraints.get('supply_claims_release_completeness_check')?.contype,
    'c',
  );
  assert.match(
    claimConstraints.get('supply_claims_release_completeness_check')
      ?.definition ?? '',
    /\(released_at IS NULL\) = \(release_reason IS NULL\)/,
  );
  assert.equal(
    claimConstraints.get('supply_claims_release_reason_check_d17b2d97')
      ?.contype,
    'c',
  );
  assert.match(
    claimConstraints.get('supply_claims_release_reason_check_d17b2d97')
      ?.definition ?? '',
    /CLAIMANT_RELEASED.*MEMBERSHIP_ENDED.*ENTRY_OBTAINED.*ENTRY_CANCELED/s,
  );
  assert.equal(
    claimConstraints.get('supply_claims_released_time_check')?.contype,
    'c',
  );
  assert.match(
    claimConstraints.get('supply_claims_released_time_check')?.definition ?? '',
    /released_at IS NULL OR released_at >= claimed_at.*released_at >= created_at/s,
  );
  assertRestrictForeignKey(
    claimConstraints,
    'supply_claims_home_id_fkey',
    /FOREIGN KEY \(home_id\).*homes\(id\)/i,
  );
  assertRestrictForeignKey(
    claimConstraints,
    'supply_claims_entry_home_fkey',
    /FOREIGN KEY \(home_id, supply_entry_id\).*supply_entries\(home_id, id\)/i,
  );
  assertRestrictForeignKey(
    claimConstraints,
    'supply_claims_claimant_home_membership_fkey',
    /FOREIGN KEY \(home_id, claimant_membership_id\).*memberships\(home_id, id\)/i,
  );

  const entryIndexes = await indexMap(client, 'supply_entries');
  assert.deepEqual(
    [...entryIndexes.keys()],
    [
      'supply_entries_home_history_idx_60894047',
      'supply_entries_home_id_created_by_membership_id_idx_889ed7bc',
      'supply_entries_home_id_id_key_2f2cccd8',
      'supply_entries_home_id_idx_f881d5c1',
      'supply_entries_home_open_idx_9cfca592',
      'supply_entries_pkey',
    ],
  );
  assert.match(
    entryIndexes.get('supply_entries_home_id_id_key_2f2cccd8') ?? '',
    /UNIQUE INDEX.*\(home_id, id\)/i,
  );
  assert.match(
    entryIndexes.get('supply_entries_home_open_idx_9cfca592') ?? '',
    /\(home_id, created_at, id\).*WHERE.*status = 'OPEN'/i,
  );
  assert.match(
    entryIndexes.get('supply_entries_home_history_idx_60894047') ?? '',
    /\(home_id, updated_at, id\).*WHERE.*status = ANY.*OBTAINED.*CANCELED/is,
  );

  const claimIndexes = await indexMap(client, 'supply_claims');
  assert.deepEqual(
    [...claimIndexes.keys()],
    [
      'supply_claims_entry_history_idx_8c80cae3',
      'supply_claims_home_active_claimant_idx_2b0b42e6',
      'supply_claims_home_id_claimant_membership_id_idx_023e58f6',
      'supply_claims_home_id_idx_f881d5c1',
      'supply_claims_home_id_supply_entry_id_idx_98811f6a',
      'supply_claims_one_active_per_entry_1e26d778',
      'supply_claims_pkey',
    ],
  );
  assert.match(
    claimIndexes.get('supply_claims_one_active_per_entry_1e26d778') ?? '',
    /UNIQUE INDEX.*\(supply_entry_id\).*WHERE.*released_at IS NULL/i,
  );
  assert.match(
    claimIndexes.get('supply_claims_entry_history_idx_8c80cae3') ?? '',
    /\(home_id, supply_entry_id, claimed_at, id\)/i,
  );
  assert.match(
    claimIndexes.get('supply_claims_home_active_claimant_idx_2b0b42e6') ?? '',
    /\(home_id, claimant_membership_id, id\).*WHERE.*released_at IS NULL/i,
  );

  const triggers = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM pg_catalog.pg_trigger
     WHERE tgrelid IN ('public.supply_entries'::regclass, 'public.supply_claims'::regclass)
       AND NOT tgisinternal`,
  );
  assert.equal(triggers.rows[0]?.count, '0');
  console.log('Supply catalog verification passed.');
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
      `34000000-0000-4000-8000-0000000000${suffix}`,
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
     VALUES ($1, 'Supply verification', 'UTC', now()),
            ($2, 'Other supply home', 'UTC', now())`,
    [...fixture.homes],
  );
  await client.query(
    `INSERT INTO memberships (id, home_id, user_id, role, ended_at)
     VALUES ($1, $5, $6, 'ADMIN', NULL),
            ($2, $5, $7, 'ROOMMATE', TIMESTAMPTZ '2026-09-12T00:00:00Z'),
            ($3, $5, $7, 'ROOMMATE', NULL),
            ($4, $8, $9, 'ADMIN', NULL)`,
    [
      ...fixture.memberships,
      fixture.homes[0],
      fixture.users[0],
      fixture.users[1],
      fixture.homes[1],
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
    'DELETE FROM supply_claims WHERE home_id = ANY($1::uuid[])',
    [fixture.homes],
  );
  await client.query(
    'DELETE FROM supply_entries WHERE home_id = ANY($1::uuid[])',
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

function transactionContext(client: PoolClient): TransactionContext {
  return {
    async query<T = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ) {
      const result = await client.query(text, [...(values ?? [])]);
      return {
        rows: result.rows as T[],
        rowCount: result.rowCount,
      };
    },
  };
}

function entryParams(
  id: string,
  fixture: Fixture,
  status = 'OPEN',
  obtainedAt: Date | null = null,
  canceledAt: Date | null = null,
  createdAt = CREATED,
): unknown[] {
  return [
    id,
    fixture.homes[0],
    `Supply ${id.slice(-4)}`,
    status,
    fixture.memberships[0],
    obtainedAt,
    canceledAt,
    createdAt,
    createdAt,
  ];
}

function claimParams(
  id: string,
  fixture: Fixture,
  entryId: string,
  claimantId = fixture.memberships[2],
  claimedAt = CLAIMED,
  releasedAt: Date | null = null,
  reason: string | null = null,
  createdAt = CLAIMED,
): unknown[] {
  return [
    id,
    fixture.homes[0],
    entryId,
    claimantId,
    claimedAt,
    releasedAt,
    reason,
    createdAt,
    releasedAt ?? createdAt,
  ];
}

async function verifyBehavior(pool: Pool): Promise<void> {
  const client = await pool.connect();
  // Keep repository reads on this transaction so uncommitted fixture rows are
  // visible while every behavior probe can still be rolled back together.
  const repository = createSupplyRepository({
    query: client.query.bind(client),
  } as unknown as Pool);
  let fixture: Fixture | undefined;
  try {
    fixture = await createFixture(client, '11');
    let serial = 1;
    const nextEntryId = () =>
      `41000000-0000-7000-8000-${String(serial++).padStart(12, '0')}`;
    const nextClaimId = () =>
      `51000000-0000-7000-8000-${String(serial++).padStart(12, '0')}`;

    const historyEntry = nextEntryId();
    await client.query(
      INSERT_SUPPLY_ENTRY_SQL,
      entryParams(historyEntry, fixture),
    );
    const firstClaim = nextClaimId();
    await client.query(
      INSERT_SUPPLY_CLAIM_SQL,
      claimParams(
        firstClaim,
        fixture,
        historyEntry,
        fixture.memberships[1],
        CLAIMED,
        RELEASED,
        'CLAIMANT_RELEASED',
      ),
    );
    const secondClaim = nextClaimId();
    await client.query(
      INSERT_SUPPLY_CLAIM_SQL,
      claimParams(secondClaim, fixture, historyEntry),
    );
    await client.query(
      `UPDATE supply_claims
       SET released_at = $2, release_reason = 'ENTRY_OBTAINED', updated_at = $2
       WHERE id = $1`,
      [secondClaim, TERMINAL],
    );
    await client.query(
      `UPDATE supply_entries
       SET status = 'OBTAINED', obtained_at = $2, updated_at = $2
       WHERE id = $1`,
      [historyEntry, TERMINAL],
    );

    const canceledEntry = nextEntryId();
    const canceledClaim = nextClaimId();
    await client.query(
      INSERT_SUPPLY_ENTRY_SQL,
      entryParams(canceledEntry, fixture),
    );
    await client.query(
      INSERT_SUPPLY_CLAIM_SQL,
      claimParams(canceledClaim, fixture, canceledEntry),
    );
    await client.query(
      `UPDATE supply_claims
       SET released_at = $2, release_reason = 'ENTRY_CANCELED', updated_at = $2
       WHERE id = $1`,
      [canceledClaim, TERMINAL],
    );
    await client.query(
      `UPDATE supply_entries
       SET status = 'CANCELED', canceled_at = $2, updated_at = $2
       WHERE id = $1`,
      [canceledEntry, TERMINAL],
    );

    const rejoinEntry = nextEntryId();
    const endedTenureClaim = nextClaimId();
    const rejoinedTenureClaim = nextClaimId();
    await client.query(
      INSERT_SUPPLY_ENTRY_SQL,
      entryParams(rejoinEntry, fixture),
    );
    await client.query(
      INSERT_SUPPLY_CLAIM_SQL,
      claimParams(
        endedTenureClaim,
        fixture,
        rejoinEntry,
        fixture.memberships[1],
        CLAIMED,
        RELEASED,
        'MEMBERSHIP_ENDED',
      ),
    );
    await client.query(
      INSERT_SUPPLY_CLAIM_SQL,
      claimParams(
        rejoinedTenureClaim,
        fixture,
        rejoinEntry,
        fixture.memberships[2],
        TERMINAL,
      ),
    );
    const rejoinState = await client.query<{
      status: string;
      claimant_membership_id: string;
      release_reason: string | null;
    }>(
      `SELECT e.status, c.claimant_membership_id, c.release_reason
       FROM supply_entries e
       JOIN supply_claims c ON c.supply_entry_id = e.id
       WHERE e.id = $1
       ORDER BY c.claimed_at, c.id`,
      [rejoinEntry],
    );
    assert.deepEqual(rejoinState.rows, [
      {
        status: 'OPEN',
        claimant_membership_id: fixture.memberships[1],
        release_reason: 'MEMBERSHIP_ENDED',
      },
      {
        status: 'OPEN',
        claimant_membership_id: fixture.memberships[2],
        release_reason: null,
      },
    ]);

    const historical = await repository.listClaimsForEntry(
      fixture.homes[0],
      historyEntry,
    );
    assert.equal(Object.isFrozen(historical), true);
    assert.deepEqual(
      historical.map((claim) => [
        claim.id,
        claim.claimantMembershipId,
        claim.releaseReason,
      ]),
      [
        [firstClaim, fixture.memberships[1], 'CLAIMANT_RELEASED'],
        [secondClaim, fixture.memberships[2], 'ENTRY_OBTAINED'],
      ],
    );
    assert.equal(Object.isFrozen(historical[0]), true);
    assert.equal('claimant_membership_id' in (historical[0] ?? {}), false);
    assert.equal(
      await repository.findActiveClaimByEntry(fixture.homes[0], historyEntry),
      null,
    );
    assert.equal(
      (await repository.findActiveClaimByEntry(fixture.homes[0], rejoinEntry))
        ?.claimantMembershipId,
      fixture.memberships[2],
    );

    await client.query('BEGIN');
    const primitiveEntry = nextEntryId();
    const insertedEntry = await repository.insertSupplyEntry(
      transactionContext(client),
      {
        id: primitiveEntry,
        homeId: fixture.homes[0],
        title: 'Repository primitive',
        status: 'OPEN',
        createdByMembershipId: fixture.memberships[0],
        obtainedAt: null,
        canceledAt: null,
        createdAt: CREATED,
        updatedAt: CREATED,
      },
    );
    assert.equal(Object.isFrozen(insertedEntry), true);
    assert.deepEqual(Object.keys(insertedEntry), [
      'id',
      'homeId',
      'title',
      'status',
      'createdByMembershipId',
      'obtainedAt',
      'canceledAt',
      'createdAt',
      'updatedAt',
    ]);
    const primitiveClaim = nextClaimId();
    const insertedClaim = await repository.insertSupplyClaim(
      transactionContext(client),
      {
        id: primitiveClaim,
        homeId: fixture.homes[0],
        supplyEntryId: primitiveEntry,
        claimantMembershipId: fixture.memberships[2],
        claimedAt: CLAIMED,
        releasedAt: null,
        releaseReason: null,
        createdAt: CLAIMED,
        updatedAt: CLAIMED,
      },
    );
    assert.equal(Object.isFrozen(insertedClaim), true);
    assert.equal('supply_entry_id' in insertedClaim, false);
    await client.query('COMMIT');

    const openEntries = await repository.listOpenEntriesByHome(
      fixture.homes[0],
    );
    assert.equal(Object.isFrozen(openEntries), true);
    assert.deepEqual(
      openEntries.map((entry) => entry.id),
      [rejoinEntry, primitiveEntry],
    );
    assert.deepEqual(
      await repository.listOpenEntriesByHome(fixture.homes[1]),
      [],
    );

    await client.query('BEGIN');
    const probeEntry = nextEntryId();
    await client.query(
      INSERT_SUPPLY_ENTRY_SQL,
      entryParams(probeEntry, fixture),
    );
    const early = new Date('2026-09-13T04:00:00.000Z');
    const entryCorruptions: ReadonlyArray<
      readonly [string, string, Date | null, Date | null, Date?]
    > = [
      ['entry_invalid_status', 'LOST', null, null],
      ['open_with_obtained_at', 'OPEN', TERMINAL, null],
      ['open_with_canceled_at', 'OPEN', null, TERMINAL],
      ['obtained_without_time', 'OBTAINED', null, null],
      ['obtained_with_canceled_at', 'OBTAINED', TERMINAL, TERMINAL],
      ['canceled_without_time', 'CANCELED', null, null],
      ['canceled_with_obtained_at', 'CANCELED', TERMINAL, TERMINAL],
      ['obtained_before_created', 'OBTAINED', early, null, CREATED],
      ['canceled_before_created', 'CANCELED', null, early, CREATED],
    ];
    for (const [
      name,
      status,
      obtainedAt,
      canceledAt,
      createdAt,
    ] of entryCorruptions) {
      await expectSqlFailure(
        client,
        name,
        INSERT_SUPPLY_ENTRY_SQL,
        entryParams(
          nextEntryId(),
          fixture,
          status,
          obtainedAt,
          canceledAt,
          createdAt,
        ),
        CHECK_VIOLATION,
      );
    }
    const claimCorruptions: ReadonlyArray<
      readonly [string, Date, Date | null, string | null, Date?]
    > = [
      ['claim_invalid_reason', CLAIMED, RELEASED, 'UNKNOWN'],
      ['released_without_reason', CLAIMED, RELEASED, null],
      ['reason_without_release', CLAIMED, null, 'CLAIMANT_RELEASED'],
      ['release_before_claim', CLAIMED, early, 'CLAIMANT_RELEASED'],
      ['release_before_created', early, CLAIMED, 'CLAIMANT_RELEASED', RELEASED],
    ];
    for (const [
      name,
      claimedAt,
      releasedAt,
      reason,
      createdAt,
    ] of claimCorruptions) {
      await expectSqlFailure(
        client,
        name,
        INSERT_SUPPLY_CLAIM_SQL,
        claimParams(
          nextClaimId(),
          fixture,
          probeEntry,
          fixture.memberships[2],
          claimedAt,
          releasedAt,
          reason,
          createdAt,
        ),
        CHECK_VIOLATION,
      );
    }
    assert.equal(entryCorruptions.length + claimCorruptions.length, 14);

    await expectSqlFailure(
      client,
      'entry_cross_home_creator',
      INSERT_SUPPLY_ENTRY_SQL,
      [
        nextEntryId(),
        fixture.homes[0],
        'Cross-home creator',
        'OPEN',
        fixture.memberships[3],
        null,
        null,
        CREATED,
        CREATED,
      ],
      FOREIGN_KEY_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'claim_cross_home_entry',
      INSERT_SUPPLY_CLAIM_SQL,
      [
        nextClaimId(),
        fixture.homes[1],
        probeEntry,
        fixture.memberships[3],
        CLAIMED,
        null,
        null,
        CLAIMED,
        CLAIMED,
      ],
      FOREIGN_KEY_VIOLATION,
    );
    await expectSqlFailure(
      client,
      'claim_cross_home_membership',
      INSERT_SUPPLY_CLAIM_SQL,
      claimParams(nextClaimId(), fixture, probeEntry, fixture.memberships[3]),
      FOREIGN_KEY_VIOLATION,
    );
    const activeProbeClaim = nextClaimId();
    await client.query(
      INSERT_SUPPLY_CLAIM_SQL,
      claimParams(activeProbeClaim, fixture, probeEntry),
    );
    await expectSqlFailure(
      client,
      'second_active_claim',
      INSERT_SUPPLY_CLAIM_SQL,
      claimParams(nextClaimId(), fixture, probeEntry, fixture.memberships[1]),
      UNIQUE_VIOLATION,
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
      [fixture.memberships[1]],
      [RESTRICT_VIOLATION, FOREIGN_KEY_VIOLATION],
    );
    await expectSqlFailure(
      client,
      'delete_referenced_entry',
      'DELETE FROM supply_entries WHERE id = $1',
      [historyEntry],
      [RESTRICT_VIOLATION, FOREIGN_KEY_VIOLATION],
    );

    const outbox = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM outbox_events
       WHERE home_id = ANY($1::uuid[]) AND event_type LIKE 'supply.%'`,
      [fixture.homes],
    );
    assert.equal(outbox.rows[0]?.count, '0');

    await client.query('SET LOCAL enable_seqscan = off');
    const plans: ReadonlyArray<readonly [string, string, readonly unknown[]]> =
      [
        [
          'supply_entries_home_open_idx_9cfca592',
          `SELECT id FROM supply_entries
         WHERE home_id = $1 AND status = 'OPEN'
         ORDER BY created_at, id`,
          [fixture.homes[0]],
        ],
        [
          'supply_entries_home_history_idx_60894047',
          `SELECT id FROM supply_entries
         WHERE home_id = $1 AND status IN ('OBTAINED', 'CANCELED')
         ORDER BY updated_at DESC, id DESC`,
          [fixture.homes[0]],
        ],
        [
          'supply_claims_entry_history_idx_8c80cae3',
          `SELECT id FROM supply_claims
         WHERE home_id = $1 AND supply_entry_id = $2
         ORDER BY claimed_at, id`,
          [fixture.homes[0], historyEntry],
        ],
        [
          'supply_claims_home_active_claimant_idx_2b0b42e6',
          `SELECT id FROM supply_claims
         WHERE home_id = $1 AND claimant_membership_id = $2
           AND released_at IS NULL
         ORDER BY id`,
          [fixture.homes[0], fixture.memberships[2]],
        ],
        [
          'supply_claims_one_active_per_entry_1e26d778',
          `SELECT id FROM supply_claims
         WHERE supply_entry_id = $1 AND released_at IS NULL`,
          [rejoinEntry],
        ],
      ];
    for (const [indexName, query, params] of plans) {
      const plan = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (COSTS OFF) ${query}`,
        [...params],
      );
      assert.match(
        plan.rows.map((row) => row['QUERY PLAN']).join('\n'),
        new RegExp(indexName),
        indexName,
      );
    }
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
    'Supply lifecycle, repository, corruption, and planner probes passed.',
  );
}

async function verifyConcurrency(pool: Pool): Promise<void> {
  const setup = await pool.connect();
  const first = await pool.connect();
  const second = await pool.connect();
  const fixture = fixtureIds('12');
  const sameEntry = '61000000-0000-7000-8000-000000000001';
  const unrelatedA = '61000000-0000-7000-8000-000000000002';
  const unrelatedB = '61000000-0000-7000-8000-000000000003';
  try {
    await createFixture(setup, '12');
    for (const id of [sameEntry, unrelatedA, unrelatedB]) {
      await setup.query(INSERT_SUPPLY_ENTRY_SQL, entryParams(id, fixture));
    }

    await first.query('BEGIN');
    await second.query('BEGIN');
    await first.query(
      INSERT_SUPPLY_CLAIM_SQL,
      claimParams(
        '62000000-0000-7000-8000-000000000001',
        fixture,
        sameEntry,
        fixture.memberships[1],
      ),
    );
    const competing = second.query(
      INSERT_SUPPLY_CLAIM_SQL,
      claimParams(
        '62000000-0000-7000-8000-000000000002',
        fixture,
        sameEntry,
        fixture.memberships[2],
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await first.query('COMMIT');
    await assert.rejects(
      competing,
      (error: unknown) => sqlState(error) === UNIQUE_VIOLATION,
    );
    await second.query('ROLLBACK');
    const survivor = await setup.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM supply_claims
       WHERE supply_entry_id = $1 AND released_at IS NULL`,
      [sameEntry],
    );
    assert.equal(survivor.rows[0]?.count, '1');

    await first.query('BEGIN');
    await second.query('BEGIN');
    const unrelatedResults = await Promise.all([
      first.query(
        INSERT_SUPPLY_CLAIM_SQL,
        claimParams(
          '62000000-0000-7000-8000-000000000003',
          fixture,
          unrelatedA,
          fixture.memberships[1],
        ),
      ),
      second.query(
        INSERT_SUPPLY_CLAIM_SQL,
        claimParams(
          '62000000-0000-7000-8000-000000000004',
          fixture,
          unrelatedB,
          fixture.memberships[2],
        ),
      ),
    ]);
    assert.deepEqual(
      unrelatedResults.map((result) => result.rowCount),
      [1, 1],
    );
    await Promise.all([first.query('COMMIT'), second.query('COMMIT')]);
    const unrelatedSurvivors = await setup.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM supply_claims
       WHERE supply_entry_id = ANY($1::uuid[]) AND released_at IS NULL`,
      [[unrelatedA, unrelatedB]],
    );
    assert.equal(unrelatedSurvivors.rows[0]?.count, '2');
  } finally {
    await first.query('ROLLBACK').catch(() => undefined);
    await second.query('ROLLBACK').catch(() => undefined);
    first.release();
    second.release();
    try {
      await cleanupFixture(setup, fixture);
    } finally {
      setup.release();
    }
  }
  console.log('Supply claim concurrency defenses passed.');
}

export async function verifySupplySchema(databaseUrl: string): Promise<void> {
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
    await verifyConcurrency(pool);
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  await verifySupplySchema(resolveTestDatabaseUrl());
}
