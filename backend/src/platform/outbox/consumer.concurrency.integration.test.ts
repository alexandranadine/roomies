import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AppConfig } from '../config/types.js';
import { createUuidV7 } from '../ids/uuid-v7.js';
import { createDatabasePool } from '../persistence/pool.js';
import {
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../persistence/test-database.js';
import type { TransactionContext } from '../persistence/transaction.js';
import { createOutboxConsumerFromPool } from './consumer.js';
import type { OutboxEvent } from './outbox-event.js';
import { createOutboxHandlerRegistry } from './registry.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const EVENT_TYPE = 'test.projection.v1';
const silentLogger = {
  info() {},
  error() {},
};
const SINK_TABLE = 'outbox_consumer_test_sink';
const NOW = new Date('2026-09-13T22:30:00.000Z');

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

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function insertEvent(
  pool: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  createdAt: Date,
): Promise<string> {
  const eventId = createUuidV7();
  await pool.query(
    `INSERT INTO outbox_events (
       event_id, event_type, occurred_at, created_at, available_at, payload
     ) VALUES ($1, $2, $3, $3, $3, '{}'::jsonb)`,
    [eventId, EVENT_TYPE, createdAt],
  );
  return eventId;
}

void describe('outbox consumer concurrent leasing', () => {
  void it('uses only a dedicated safe TEST_DATABASE_URL', () => {
    assert.equal(
      skipWithoutDatabase === false,
      Boolean(process.env['TEST_DATABASE_URL']?.trim()),
    );
  });

  void it(
    'does not let two workers process the same event at once',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const ids: string[] = [];
      try {
        await database.pool.query(`
          CREATE TABLE IF NOT EXISTS ${SINK_TABLE} (
            event_id uuid PRIMARY KEY,
            note text NOT NULL
          )
        `);
        const eventId = await insertEvent(database.pool, NOW);
        ids.push(eventId);

        const started = deferred();
        const hold = deferred();
        let overlapping = 0;
        let maxOverlap = 0;

        const handler = Object.freeze({
          handlerId: 'concurrent',
          eventTypes: [EVENT_TYPE],
          async handle(tx: TransactionContext, event: OutboxEvent) {
            overlapping += 1;
            maxOverlap = Math.max(maxOverlap, overlapping);
            started.resolve();
            await hold.promise;
            overlapping -= 1;
            await tx.query(
              `INSERT INTO ${SINK_TABLE} (event_id, note) VALUES ($1, $2)`,
              [event.eventId, 'ok'],
            );
          },
        });

        const first = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([handler]),
          clock: { now: () => NOW },
          logger: silentLogger,
        });
        const second = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([handler]),
          clock: { now: () => NOW },
          logger: silentLogger,
        });

        const firstDrain = first.drain({ batchSize: 5 });
        await started.promise;
        const secondResult = await second.drain({ batchSize: 5 });
        hold.resolve();
        const firstResult = await firstDrain;

        assert.equal(firstResult.processedCount, 1);
        assert.equal(secondResult.processedCount, 0);
        assert.equal(maxOverlap, 1);
        const sink = await database.pool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM ${SINK_TABLE} WHERE event_id = $1`,
          [eventId],
        );
        assert.equal(sink.rows[0]?.count, 1);
      } finally {
        if (ids.length > 0) {
          await database.pool.query(
            `DELETE FROM outbox_events WHERE event_id = ANY($1)`,
            [ids],
          );
          await database.pool.query(
            `DELETE FROM ${SINK_TABLE} WHERE event_id = ANY($1)`,
            [ids],
          );
        }
        await database.close();
      }
    },
  );

  void it(
    'lets a second worker progress on another event via SKIP LOCKED',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const ids: string[] = [];
      try {
        await database.pool.query(`
          CREATE TABLE IF NOT EXISTS ${SINK_TABLE} (
            event_id uuid PRIMARY KEY,
            note text NOT NULL
          )
        `);
        const firstId = await insertEvent(
          database.pool,
          new Date('2026-09-13T21:00:00.000Z'),
        );
        const secondId = await insertEvent(
          database.pool,
          new Date('2026-09-13T21:01:00.000Z'),
        );
        ids.push(firstId, secondId);

        const started = deferred();
        const hold = deferred();
        const first = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([
            Object.freeze({
              handlerId: 'first_worker',
              eventTypes: [EVENT_TYPE],
              async handle(tx: TransactionContext, event: OutboxEvent) {
                started.resolve();
                await hold.promise;
                await tx.query(
                  `INSERT INTO ${SINK_TABLE} (event_id, note) VALUES ($1, $2)`,
                  [event.eventId, 'first-worker'],
                );
              },
            }),
          ]),
          clock: { now: () => NOW },
          logger: silentLogger,
        });
        const second = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([
            Object.freeze({
              handlerId: 'second_worker',
              eventTypes: [EVENT_TYPE],
              async handle(tx: TransactionContext, event: OutboxEvent) {
                await tx.query(
                  `INSERT INTO ${SINK_TABLE} (event_id, note) VALUES ($1, $2)`,
                  [event.eventId, 'second-worker'],
                );
              },
            }),
          ]),
          clock: { now: () => NOW },
          logger: silentLogger,
        });

        const firstDrain = first.drain({ batchSize: 5 });
        await started.promise;
        const secondResult = await second.drain({ batchSize: 5 });
        assert.equal(secondResult.processedCount, 1);
        hold.resolve();
        const firstResult = await firstDrain;
        assert.equal(firstResult.processedCount, 1);

        const sink = await database.pool.query<{
          event_id: string;
          note: string;
        }>(
          `SELECT event_id, note FROM ${SINK_TABLE} WHERE event_id = ANY($1)
           ORDER BY note`,
          [ids],
        );
        assert.equal(sink.rows.length, 2);
        const notes = new Set(sink.rows.map((row) => row.note));
        assert.equal(notes.has('first-worker'), true);
        assert.equal(notes.has('second-worker'), true);
      } finally {
        if (ids.length > 0) {
          await database.pool.query(
            `DELETE FROM outbox_events WHERE event_id = ANY($1)`,
            [ids],
          );
          await database.pool.query(
            `DELETE FROM ${SINK_TABLE} WHERE event_id = ANY($1)`,
            [ids],
          );
        }
        await database.close();
      }
    },
  );

  void it(
    'does not lose events under two concurrent drains',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const ids: string[] = [];
      try {
        await database.pool.query(`
          CREATE TABLE IF NOT EXISTS ${SINK_TABLE} (
            event_id uuid PRIMARY KEY,
            note text NOT NULL
          )
        `);
        for (let index = 0; index < 20; index += 1) {
          ids.push(
            await insertEvent(
              database.pool,
              new Date(NOW.getTime() + index * 1000),
            ),
          );
        }

        const handler = Object.freeze({
          handlerId: 'concurrent',
          eventTypes: [EVENT_TYPE],
          async handle(tx: TransactionContext, event: OutboxEvent) {
            await tx.query(
              `INSERT INTO ${SINK_TABLE} (event_id, note)
               VALUES ($1, $2)
               ON CONFLICT (event_id) DO NOTHING`,
              [event.eventId, 'ok'],
            );
          },
        });
        const first = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([handler]),
          clock: { now: () => new Date(NOW.getTime() + 60_000) },
          logger: silentLogger,
        });
        const second = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([handler]),
          clock: { now: () => new Date(NOW.getTime() + 60_000) },
          logger: silentLogger,
        });

        const [firstResult, secondResult] = await Promise.all([
          first.drain({ batchSize: 20 }),
          second.drain({ batchSize: 20 }),
        ]);
        assert.equal(
          firstResult.processedCount + secondResult.processedCount,
          20,
        );

        const remaining = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM outbox_events
           WHERE event_id = ANY($1) AND processed_at IS NULL`,
          [ids],
        );
        assert.equal(remaining.rows[0]?.count, '0');
        const sink = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${SINK_TABLE}
           WHERE event_id = ANY($1)`,
          [ids],
        );
        assert.equal(sink.rows[0]?.count, '20');
      } finally {
        if (ids.length > 0) {
          await database.pool.query(
            `DELETE FROM outbox_events WHERE event_id = ANY($1)`,
            [ids],
          );
          await database.pool.query(
            `DELETE FROM ${SINK_TABLE} WHERE event_id = ANY($1)`,
            [ids],
          );
        }
        await database.close();
      }
    },
  );
});
