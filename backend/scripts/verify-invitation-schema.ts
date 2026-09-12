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
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
};

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
  const columns = await client.query<ColumnRow>(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'invitations'
    ORDER BY ordinal_position
  `);
  assert.deepEqual(
    columns.rows.map((row) => [
      row.column_name,
      row.data_type,
      row.is_nullable,
      row.column_default,
    ]),
    [
      ['accepted_at', 'timestamp with time zone', 'YES', null],
      ['accepted_membership_id', 'uuid', 'YES', null],
      ['created_at', 'timestamp with time zone', 'NO', null],
      ['created_by_membership_id', 'uuid', 'NO', null],
      ['expires_at', 'timestamp with time zone', 'NO', null],
      ['home_id', 'uuid', 'NO', null],
      ['id', 'uuid', 'NO', null],
      ['invited_email', 'text', 'NO', null],
      ['revocation_cause', 'text', 'YES', null],
      ['revoked_at', 'timestamp with time zone', 'YES', null],
      ['token_hash', 'bytea', 'NO', null],
    ],
  );

  const constraints = await client.query<{
    conname: string;
    contype: string;
    definition: string;
  }>(`
    SELECT conname, contype, pg_get_constraintdef(oid, true) AS definition
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.invitations'::regclass
    ORDER BY conname
  `);
  const byName = new Map(constraints.rows.map((row) => [row.conname, row]));
  for (const name of [
    'invitations_acceptance_completeness_check',
    'invitations_accepted_time_check',
    'invitations_email_canonical_check',
    'invitations_expiry_order_check',
    'invitations_revocation_cause_check',
    'invitations_revocation_completeness_check',
    'invitations_revoked_time_check',
    'invitations_terminal_state_check',
    'invitations_token_hash_length_check',
  ]) {
    assert.equal(byName.get(name)?.contype, 'c', name);
  }
  assert.equal(byName.get('invitations_pkey')?.contype, 'p');
  assert.match(
    byName.get('invitations_home_id_fkey')?.definition ?? '',
    /FOREIGN KEY \(home_id\).*homes\(id\).*ON UPDATE RESTRICT ON DELETE RESTRICT/i,
  );
  assert.match(
    byName.get('invitations_creator_home_membership_fkey')?.definition ?? '',
    /FOREIGN KEY \(home_id, created_by_membership_id\).*memberships\(home_id, id\).*ON UPDATE RESTRICT ON DELETE RESTRICT/i,
  );
  assert.match(
    byName.get('invitations_accepted_home_membership_fkey')?.definition ?? '',
    /FOREIGN KEY \(home_id, accepted_membership_id\).*memberships\(home_id, id\).*ON UPDATE RESTRICT ON DELETE RESTRICT/i,
  );
  const exclusion =
    byName.get('invitations_nonoverlapping_validity')?.definition ?? '';
  assert.match(exclusion, /^EXCLUDE USING gist/i);
  assert.match(
    exclusion,
    /tstzrange\(created_at, COALESCE\(accepted_at, revoked_at, expires_at\)/i,
  );
  assert.doesNotMatch(exclusion, /\bnow\s*\(/i);

  const indexes = await client.query<{
    indexname: string;
    indexdef: string;
  }>(`
    SELECT indexname, indexdef
    FROM pg_catalog.pg_indexes
    WHERE schemaname = 'public' AND tablename = 'invitations'
    ORDER BY indexname
  `);
  const indexDefinitions = indexes.rows.map((row) => row.indexdef).join('\n');
  for (const prefix of [
    'invitations_accepted_membership_uidx_',
    'invitations_created_by_membership_idx_',
    'invitations_home_open_idx_',
    'invitations_token_hash_uidx_',
  ]) {
    assert.ok(
      indexes.rows.some((row) => row.indexname.startsWith(prefix)),
      prefix,
    );
  }
  assert.match(
    indexDefinitions,
    /UNIQUE INDEX .*invitations_accepted_membership_uidx_.*WHERE .*accepted_membership_id IS NOT NULL/i,
  );
  assert.match(
    indexDefinitions,
    /invitations_home_open_idx_.*\(home_id, expires_at, created_at, id\).*WHERE .*accepted_at IS NULL.*revoked_at IS NULL/i,
  );
  assert.doesNotMatch(indexDefinitions, /\bnow\s*\(/i);
  assert.equal(
    (
      await client.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'btree_gist'
         ) AS present`,
      )
    ).rows[0]?.present,
    true,
  );
  console.log('Invitation catalog verification passed.');
}

const INSERT_SQL = `
  INSERT INTO invitations (
    id, home_id, invited_email, token_hash, created_by_membership_id,
    created_at, expires_at, accepted_at, accepted_membership_id,
    revoked_at, revocation_cause
  ) VALUES (
    $1::uuid, $2::uuid, $3, $4::bytea, $5::uuid,
    $6::timestamptz, $7::timestamptz, $8::timestamptz, $9::uuid,
    $10::timestamptz, $11
  )
`;

type InvitationInput = {
  id: string;
  homeId: string;
  email: string;
  token: Buffer;
  creatorId: string;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt?: Date | null;
  acceptedMembershipId?: string | null;
  revokedAt?: Date | null;
  revocationCause?: string | null;
};

async function insert(
  client: PoolClient,
  input: InvitationInput,
): Promise<void> {
  await client.query(INSERT_SQL, [
    input.id,
    input.homeId,
    input.email,
    input.token,
    input.creatorId,
    input.createdAt,
    input.expiresAt,
    input.acceptedAt ?? null,
    input.acceptedMembershipId ?? null,
    input.revokedAt ?? null,
    input.revocationCause ?? null,
  ]);
}

async function createFixture(client: PoolClient, suffix: string) {
  const userA = `10000000-0000-4000-8000-0000000000${suffix}`;
  const userB = `20000000-0000-4000-8000-0000000000${suffix}`;
  const home = `30000000-0000-4000-8000-0000000000${suffix}`;
  const otherHome = `40000000-0000-4000-8000-0000000000${suffix}`;
  const creator = `50000000-0000-4000-8000-0000000000${suffix}`;
  const accepted = `60000000-0000-4000-8000-0000000000${suffix}`;
  const otherMembership = `70000000-0000-4000-8000-0000000000${suffix}`;
  await client.query(
    `INSERT INTO users (id, updated_at) VALUES ($1, now()), ($2, now())`,
    [userA, userB],
  );
  await client.query(
    `INSERT INTO homes (id, name, timezone, updated_at)
     VALUES ($1, 'Invite test', 'UTC', now()), ($2, 'Other', 'UTC', now())`,
    [home, otherHome],
  );
  await client.query(
    `INSERT INTO memberships (id, home_id, user_id, role)
     VALUES ($1, $2, $3, 'ADMIN'), ($4, $2, $5, 'ROOMMATE'),
            ($6, $7, $5, 'ADMIN')`,
    [creator, home, userA, accepted, userB, otherMembership, otherHome],
  );
  return { userA, userB, home, otherHome, creator, accepted, otherMembership };
}

async function verifyBehavior(client: PoolClient): Promise<void> {
  await client.query('BEGIN');
  try {
    const fixture = await createFixture(client, '01');
    const start = new Date('2026-10-01T00:00:00.000Z');
    const end = new Date('2026-10-08T00:00:00.000Z');
    let serial = 1;
    const nextId = () =>
      `80000000-0000-7000-8000-${String(serial++).padStart(12, '0')}`;
    const nextToken = () => Buffer.alloc(32, serial++ % 255);
    const valid = (email: string): InvitationInput => ({
      id: nextId(),
      homeId: fixture.home,
      email,
      token: nextToken(),
      creatorId: fixture.creator,
      createdAt: start,
      expiresAt: end,
    });

    await insert(client, valid('insert@example.com'));
    await expectSqlFailure(
      client,
      'missing_id',
      `INSERT INTO invitations (
         home_id, invited_email, token_hash, created_by_membership_id,
         created_at, expires_at
       ) VALUES ($1, 'missing-id@example.com', $2, $3, $4, $5)`,
      [fixture.home, nextToken(), fixture.creator, start, end],
      '23502',
    );
    await expectSqlFailure(
      client,
      'short_hash',
      INSERT_SQL,
      [
        nextId(),
        fixture.home,
        'short@example.com',
        Buffer.alloc(31),
        fixture.creator,
        start,
        end,
        null,
        null,
        null,
        null,
      ],
      '23514',
    );
    const duplicateToken = nextToken();
    await insert(client, {
      ...valid('token-one@example.com'),
      token: duplicateToken,
    });
    await expectSqlFailure(
      client,
      'duplicate_hash',
      INSERT_SQL,
      [
        nextId(),
        fixture.home,
        'token-two@example.com',
        duplicateToken,
        fixture.creator,
        start,
        end,
        null,
        null,
        null,
        null,
      ],
      '23505',
    );
    for (const [savepoint, input] of [
      [
        'home_fk',
        { ...valid('home-fk@example.com'), homeId: crypto.randomUUID() },
      ],
      [
        'creator_fk',
        { ...valid('creator-fk@example.com'), creatorId: crypto.randomUUID() },
      ],
      [
        'creator_home',
        {
          ...valid('creator-home@example.com'),
          creatorId: fixture.otherMembership,
        },
      ],
    ] as const) {
      await expectSqlFailure(
        client,
        savepoint,
        INSERT_SQL,
        [
          input.id,
          input.homeId,
          input.email,
          input.token,
          input.creatorId,
          input.createdAt,
          input.expiresAt,
          null,
          null,
          null,
          null,
        ],
        '23503',
      );
    }
    const acceptedAt = new Date('2026-10-02T00:00:00.000Z');
    for (const [savepoint, values, code] of [
      ['accepted_pair', [acceptedAt, null], '23514'],
      ['accepted_fk', [acceptedAt, crypto.randomUUID()], '23503'],
      ['accepted_home', [acceptedAt, fixture.otherMembership], '23503'],
      [
        'accepted_before_create',
        [new Date('2026-09-30T00:00:00Z'), fixture.accepted],
        '23514',
      ],
      ['accepted_at_expiry', [end, fixture.accepted], '23514'],
    ] as const) {
      const input = valid(`${savepoint}@example.com`);
      await expectSqlFailure(
        client,
        savepoint,
        INSERT_SQL,
        [
          input.id,
          input.homeId,
          input.email,
          input.token,
          input.creatorId,
          input.createdAt,
          input.expiresAt,
          values[0],
          values[1],
          null,
          null,
        ],
        code,
      );
    }
    const expiryInput = valid('expiry-order@example.com');
    await expectSqlFailure(
      client,
      'expiry_order',
      INSERT_SQL,
      [
        expiryInput.id,
        expiryInput.homeId,
        expiryInput.email,
        expiryInput.token,
        expiryInput.creatorId,
        start,
        start,
        null,
        null,
        null,
        null,
      ],
      '23514',
    );
    for (const [savepoint, revokedAt, cause] of [
      ['revoke_pair', acceptedAt, null],
      ['revoke_cause', acceptedAt, 'EXPIRED'],
      [
        'revoke_before_create',
        new Date('2026-09-30T00:00:00Z'),
        'ADMIN_REVOKED',
      ],
      ['revoke_at_expiry', end, 'HOME_ARCHIVED'],
    ] as const) {
      const input = valid(`${savepoint}@example.com`);
      await expectSqlFailure(
        client,
        savepoint,
        INSERT_SQL,
        [
          input.id,
          input.homeId,
          input.email,
          input.token,
          input.creatorId,
          start,
          end,
          null,
          null,
          revokedAt,
          cause,
        ],
        '23514',
      );
    }
    const terminal = valid('terminal@example.com');
    await expectSqlFailure(
      client,
      'terminal_exclusive',
      INSERT_SQL,
      [
        terminal.id,
        terminal.homeId,
        terminal.email,
        terminal.token,
        terminal.creatorId,
        start,
        end,
        acceptedAt,
        fixture.accepted,
        acceptedAt,
        'ADMIN_REVOKED',
      ],
      '23514',
    );
    for (const [savepoint, email] of [
      ['email_upper', 'UPPER@example.com'],
      ['email_space', ' spaced@example.com '],
    ]) {
      const input = valid(email);
      await expectSqlFailure(
        client,
        savepoint,
        INSERT_SQL,
        [
          input.id,
          input.homeId,
          input.email,
          input.token,
          input.creatorId,
          start,
          end,
          null,
          null,
          null,
          null,
        ],
        '23514',
      );
    }

    await insert(client, valid('overlap@example.com'));
    const overlap = valid('overlap@example.com');
    overlap.createdAt = new Date('2026-10-03T00:00:00Z');
    overlap.expiresAt = new Date('2026-10-10T00:00:00Z');
    await expectSqlFailure(
      client,
      'effective_overlap',
      INSERT_SQL,
      [
        overlap.id,
        overlap.homeId,
        overlap.email,
        overlap.token,
        overlap.creatorId,
        overlap.createdAt,
        overlap.expiresAt,
        null,
        null,
        null,
        null,
      ],
      '23P01',
    );

    await insert(client, valid('expired-replace@example.com'));
    await insert(client, {
      ...valid('expired-replace@example.com'),
      createdAt: end,
      expiresAt: new Date('2026-10-15T00:00:00Z'),
    });
    await insert(client, {
      ...valid('accepted-replace@example.com'),
      acceptedAt,
      acceptedMembershipId: fixture.accepted,
    });
    await insert(client, {
      ...valid('accepted-replace@example.com'),
      createdAt: acceptedAt,
      expiresAt: new Date('2026-10-09T00:00:00Z'),
    });
    await insert(client, {
      ...valid('revoked-replace@example.com'),
      revokedAt: acceptedAt,
      revocationCause: 'ADMIN_REVOKED',
    });
    await insert(client, {
      ...valid('revoked-replace@example.com'),
      createdAt: acceptedAt,
      expiresAt: new Date('2026-10-09T00:00:00Z'),
    });
    const reused = valid('accepted-reuse@example.com');
    await expectSqlFailure(
      client,
      'accepted_membership_reuse',
      INSERT_SQL,
      [
        reused.id,
        reused.homeId,
        reused.email,
        reused.token,
        reused.creatorId,
        start,
        end,
        acceptedAt,
        fixture.accepted,
        null,
        null,
      ],
      '23505',
    );

    await client.query('SET LOCAL enable_seqscan = off');
    const plan = await client.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (COSTS OFF)
       SELECT id FROM invitations
       WHERE home_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
       ORDER BY expires_at, created_at, id
       FOR UPDATE`,
      [fixture.home],
    );
    assert.match(
      plan.rows.map((row) => row['QUERY PLAN']).join('\n'),
      /invitations_home_open_idx_/,
    );
  } finally {
    await client.query('ROLLBACK');
  }
  console.log('Invitation SQLSTATE and invariant probes passed.');
}

async function verifyConcurrentDefense(pool: Pool): Promise<void> {
  const setup = await pool.connect();
  const first = await pool.connect();
  const second = await pool.connect();
  const suffix = '02';
  let fixture: Awaited<ReturnType<typeof createFixture>> | undefined;
  try {
    await setup.query('BEGIN');
    fixture = await createFixture(setup, suffix);
    await setup.query('COMMIT');
    const createdAt = new Date('2026-10-01T00:00:00Z');
    const expiresAt = new Date('2026-10-08T00:00:00Z');
    await first.query('BEGIN');
    await second.query('BEGIN');
    await insert(first, {
      id: '80000000-0000-7000-8000-000000009001',
      homeId: fixture.home,
      email: 'concurrent@example.com',
      token: Buffer.alloc(32, 201),
      creatorId: fixture.creator,
      createdAt,
      expiresAt,
    });
    const competing = insert(second, {
      id: '80000000-0000-7000-8000-000000009002',
      homeId: fixture.home,
      email: 'concurrent@example.com',
      token: Buffer.alloc(32, 202),
      creatorId: fixture.creator,
      createdAt,
      expiresAt,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await first.query('COMMIT');
    await assert.rejects(
      competing,
      (error: unknown) => sqlState(error) === '23P01',
    );
    await second.query('ROLLBACK');
  } finally {
    await first.query('ROLLBACK').catch(() => undefined);
    await second.query('ROLLBACK').catch(() => undefined);
    first.release();
    second.release();
    if (fixture) {
      await setup.query('DELETE FROM invitations WHERE home_id = $1', [
        fixture.home,
      ]);
      await setup.query('DELETE FROM memberships WHERE home_id IN ($1, $2)', [
        fixture.home,
        fixture.otherHome,
      ]);
      await setup.query('DELETE FROM homes WHERE id IN ($1, $2)', [
        fixture.home,
        fixture.otherHome,
      ]);
      await setup.query('DELETE FROM users WHERE id IN ($1, $2)', [
        fixture.userA,
        fixture.userB,
      ]);
    }
    setup.release();
  }
  console.log('Concurrent invitation exclusion defense passed.');
}

export async function verifyInvitationSchema(
  databaseUrl: string,
): Promise<void> {
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
    await verifyConcurrentDefense(pool);
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  await verifyInvitationSchema(resolveTestDatabaseUrl());
}
