import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { AppConfig } from '../config/types.js';
import { createDatabasePool } from '../persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../persistence/test-database.js';
import { runInReadCommittedTransaction } from '../persistence/transaction.js';
import type { TransactionContext } from '../persistence/transaction.js';
import { createMembershipEndedV1Event } from '../../domains/memberships/events.js';
import { createMembershipRoleChangedV1Event } from '../../domains/memberships/events.js';
import { createOutboxWriter } from './outbox-writer.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();

type OutboxRow = {
  event_id: string;
  event_type: string;
  occurred_at: Date;
  created_at: Date;
  available_at: Date;
  home_id: string | null;
  payload: unknown;
  attempt_count: number;
  lease_owner: string | null;
  leased_at: Date | null;
  lease_until: Date | null;
  processed_at: Date | null;
  dead_at: Date | null;
  last_failed_at: Date | null;
  last_error_code: string | null;
};

function testConfig(databaseUrl: string): AppConfig {
  return {
    appEnv: 'test',
    port: 3000,
    databaseUrl,
    authBaseUrl: 'http://localhost:3000',
    authSecret: 'roomies_test_secret_32_chars_minimum_value',
    secureAuthCookies: false,
    frontendOrigin: 'http://localhost:5173',
    trustedOrigins: ['http://localhost:5173'],
    trustProxyHops: 0,
  };
}

function createTestUuidV7(): string {
  const bytes = randomBytes(16);
  const ms = BigInt(Date.now());
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  const randA = bytes[6] ?? 0;
  const variant = bytes[8] ?? 0;
  bytes[6] = (randA & 0x0f) | 0x70;
  bytes[8] = (variant & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function insertHome(
  tx: TransactionContext,
  input: { id: string; name: string },
): Promise<void> {
  await tx.query(
    `INSERT INTO homes (id, name, timezone, updated_at)
     VALUES ($1, $2, 'UTC', NOW())`,
    [input.id, input.name],
  );
}

function dedicatedTestDatabaseUrl(): string {
  return resolveSafeDedicatedTestDatabaseUrl();
}

const SELECT_OUTBOX_SQL = `
SELECT event_id, event_type, occurred_at, created_at, available_at, home_id,
       payload, attempt_count, lease_owner, leased_at, lease_until,
       processed_at, dead_at, last_failed_at, last_error_code
FROM outbox_events
WHERE event_id = $1
`;

void describe('OutboxWriter PostgreSQL atomicity', () => {
  void it(
    'uses only a dedicated safe TEST_DATABASE_URL',
    { skip: skipWithoutDatabase },
    async () => {
      const url = dedicatedTestDatabaseUrl();
      const parsed = parseDatabaseUrl(url);
      assert.notEqual(parsed.database.toLowerCase(), 'roomies');
      assert.match(parsed.database, /(?:^|_)(?:test|ci)$/i);

      const database = createDatabasePool(testConfig(url));
      try {
        const result = await database.pool.query<{ current_database: string }>(
          'SELECT current_database()',
        );
        const connected = result.rows[0]?.current_database ?? '';
        assert.notEqual(connected.toLowerCase(), 'roomies');
        assert.match(connected, /(?:^|_)(?:test|ci)$/i);
      } finally {
        await database.close();
      }
    },
  );

  void it(
    'commits a domain write and outbox event together with default processing fields',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const writer = createOutboxWriter();
      const homeId = randomUUID();
      const eventId = createTestUuidV7();
      const membershipId = randomUUID();
      const occurredAt = new Date('2026-03-15T12:34:56.789Z');
      const seen: TransactionContext[] = [];

      try {
        await runInReadCommittedTransaction(database.pool, async (tx) => {
          seen.push(tx);
          await insertHome(tx, { id: homeId, name: 'Outbox Success Home' });
          await writer.append(
            tx,
            createMembershipEndedV1Event({
              eventId,
              occurredAt,
              membershipId,
              cause: 'VOLUNTARY_LEAVE',
              homeId,
            }),
          );
          seen.push(tx);
        });

        assert.equal(seen.length, 2);
        assert.equal(seen[0], seen[1]);

        const home = await database.pool.query<{ id: string }>(
          'SELECT id FROM homes WHERE id = $1',
          [homeId],
        );
        assert.equal(home.rows.length, 1);

        const outbox = await database.pool.query<OutboxRow>(SELECT_OUTBOX_SQL, [
          eventId,
        ]);
        assert.equal(outbox.rows.length, 1);
        const row = outbox.rows[0];
        assert.ok(row);
        assert.equal(row.event_id, eventId);
        assert.equal(row.event_type, 'membership.ended.v1');
        assert.equal(row.occurred_at.toISOString(), occurredAt.toISOString());
        assert.equal(row.home_id, homeId);
        assert.deepEqual(row.payload, {
          membershipId,
          cause: 'VOLUNTARY_LEAVE',
        });
        assert.ok(row.created_at instanceof Date);
        assert.ok(row.available_at instanceof Date);
        assert.equal(Number.isNaN(row.created_at.getTime()), false);
        assert.equal(Number.isNaN(row.available_at.getTime()), false);
        assert.equal(row.attempt_count, 0);
        assert.equal(row.lease_owner, null);
        assert.equal(row.leased_at, null);
        assert.equal(row.lease_until, null);
        assert.equal(row.processed_at, null);
        assert.equal(row.dead_at, null);
        assert.equal(row.last_failed_at, null);
        assert.equal(row.last_error_code, null);
      } finally {
        await database.pool.query(
          'DELETE FROM outbox_events WHERE event_id = $1',
          [eventId],
        );
        await database.pool.query('DELETE FROM homes WHERE id = $1', [homeId]);
        await database.close();
      }
    },
  );

  void it(
    'rolls back the domain write when append reaches the database and fails',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const writer = createOutboxWriter();
      const existingEventId = createTestUuidV7();
      const homeId = randomUUID();
      const occurredAt = new Date('2026-04-01T00:00:00.000Z');

      try {
        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await writer.append(
            tx,
            createMembershipEndedV1Event({
              eventId: existingEventId,
              occurredAt,
              membershipId: randomUUID(),
              cause: 'ADMIN_REMOVAL',
            }),
          );
        });

        await assert.rejects(() =>
          runInReadCommittedTransaction(database.pool, async (tx) => {
            await insertHome(tx, { id: homeId, name: 'Append Fail Home' });
            await writer.append(
              tx,
              createMembershipRoleChangedV1Event({
                eventId: existingEventId,
                occurredAt: new Date('2026-04-02T00:00:00.000Z'),
                membershipId: randomUUID(),
                previousRole: 'ROOMMATE',
                newRole: 'ADMIN',
                homeId,
              }),
            );
          }),
        );

        const home = await database.pool.query(
          'SELECT id FROM homes WHERE id = $1',
          [homeId],
        );
        assert.equal(home.rows.length, 0);

        const outbox = await database.pool.query<OutboxRow>(SELECT_OUTBOX_SQL, [
          existingEventId,
        ]);
        assert.equal(outbox.rows.length, 1);
        assert.equal(outbox.rows[0]?.event_type, 'membership.ended.v1');
        assert.equal(outbox.rows[0]?.home_id, null);
      } finally {
        await database.pool.query(
          'DELETE FROM outbox_events WHERE event_id = $1',
          [existingEventId],
        );
        await database.pool.query('DELETE FROM homes WHERE id = $1', [homeId]);
        await database.close();
      }
    },
  );

  void it(
    'rolls back an appended event when later work fails',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const writer = createOutboxWriter();
      const homeId = randomUUID();
      const eventId = createTestUuidV7();

      try {
        await assert.rejects(
          () =>
            runInReadCommittedTransaction(database.pool, async (tx) => {
              await writer.append(
                tx,
                createMembershipEndedV1Event({
                  eventId,
                  occurredAt: new Date('2026-05-01T00:00:00.000Z'),
                  membershipId: randomUUID(),
                  cause: 'HOME_ARCHIVED',
                }),
              );
              await insertHome(tx, { id: homeId, name: 'Later Fail Home' });
              throw new Error('domain failure after append');
            }),
          (error: unknown) =>
            error instanceof Error &&
            error.message === 'domain failure after append',
        );

        const home = await database.pool.query(
          'SELECT id FROM homes WHERE id = $1',
          [homeId],
        );
        assert.equal(home.rows.length, 0);

        const outbox = await database.pool.query(SELECT_OUTBOX_SQL, [eventId]);
        assert.equal(outbox.rows.length, 0);
      } finally {
        await database.pool.query(
          'DELETE FROM outbox_events WHERE event_id = $1',
          [eventId],
        );
        await database.pool.query('DELETE FROM homes WHERE id = $1', [homeId]);
        await database.close();
      }
    },
  );

  void it(
    'rejects a duplicate event_id on a later committed identity and leaves the original row',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const writer = createOutboxWriter();
      const eventId = createTestUuidV7();
      const firstMembershipId = randomUUID();
      const firstOccurredAt = new Date('2026-06-01T08:00:00.000Z');

      try {
        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await writer.append(
            tx,
            createMembershipEndedV1Event({
              eventId,
              occurredAt: firstOccurredAt,
              membershipId: firstMembershipId,
              cause: 'VOLUNTARY_LEAVE',
            }),
          );
        });

        await assert.rejects(() =>
          runInReadCommittedTransaction(database.pool, async (tx) => {
            await writer.append(
              tx,
              createMembershipRoleChangedV1Event({
                eventId,
                occurredAt: new Date('2026-06-02T08:00:00.000Z'),
                membershipId: randomUUID(),
                previousRole: 'ADMIN',
                newRole: 'ROOMMATE',
              }),
            );
          }),
        );

        const outbox = await database.pool.query<OutboxRow>(SELECT_OUTBOX_SQL, [
          eventId,
        ]);
        assert.equal(outbox.rows.length, 1);
        const row = outbox.rows[0];
        assert.ok(row);
        assert.equal(row.event_type, 'membership.ended.v1');
        assert.equal(
          row.occurred_at.toISOString(),
          firstOccurredAt.toISOString(),
        );
        assert.deepEqual(row.payload, {
          membershipId: firstMembershipId,
          cause: 'VOLUNTARY_LEAVE',
        });
        assert.equal(row.attempt_count, 0);
        assert.equal(row.processed_at, null);
      } finally {
        await database.pool.query(
          'DELETE FROM outbox_events WHERE event_id = $1',
          [eventId],
        );
        await database.close();
      }
    },
  );

  void it(
    'round-trips envelope fields through raw SQL without unexpected payload keys',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const writer = createOutboxWriter();
      const eventId = createTestUuidV7();
      const homeId = randomUUID();
      const membershipId = randomUUID();
      const occurredAt = new Date('2026-07-04T16:20:30.123Z');

      try {
        await runInReadCommittedTransaction(database.pool, async (tx) => {
          await writer.append(
            tx,
            createMembershipEndedV1Event({
              eventId,
              occurredAt,
              membershipId,
              cause: 'VOLUNTARY_LEAVE',
              homeId,
            }),
          );
        });

        const outbox = await database.pool.query<OutboxRow>(SELECT_OUTBOX_SQL, [
          eventId,
        ]);
        const row = outbox.rows[0];
        assert.ok(row);
        assert.equal(row.event_id, eventId);
        assert.equal(row.event_type, 'membership.ended.v1');
        assert.equal(row.occurred_at.toISOString(), occurredAt.toISOString());
        assert.equal(row.home_id, homeId);
        assert.deepEqual(row.payload, {
          membershipId,
          cause: 'VOLUNTARY_LEAVE',
        });
        assert.deepEqual(Object.keys(row.payload as object).sort(), [
          'cause',
          'membershipId',
        ]);
        assert.equal(JSON.stringify(row.payload).includes('email'), false);
        assert.equal(row.attempt_count, 0);
        assert.equal(row.lease_owner, null);
      } finally {
        await database.pool.query(
          'DELETE FROM outbox_events WHERE event_id = $1',
          [eventId],
        );
        await database.close();
      }
    },
  );
});
