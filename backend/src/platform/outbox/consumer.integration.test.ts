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
import type { OutboxEventHandler } from './handler.js';
import type {
  OutboxConsumerLogFields,
  OutboxConsumerLogger,
} from './logging.js';
import { createOutboxHandlerRegistry } from './registry.js';
import type { OutboxRetryPolicy } from './retry-policy.js';
import { outboxRetryBackoffMs } from './retry-policy.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();

const PROJECTION_V1 = 'test.projection.v1';
const PROJECTION_V2 = 'test.projection.v2';
const OTHER_V1 = 'test.other.v1';
const UNSUBSCRIBED_V1 = 'test.unsubscribed.v1';

const SENTINEL_TITLE = 'Leaky Maintenance Title';
const SENTINEL_EMAIL = 'jamie@example.com';
const SENTINEL_PAYLOAD = 'SECRET_PAYLOAD_SENTINEL';
const SENTINEL_MEMBERSHIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const SINK_TABLE = 'outbox_consumer_test_sink';
const PIPELINE_TABLE = 'outbox_consumer_test_pipeline';
const NOW = new Date('2026-09-13T22:00:00.000Z');

const TEST_RETRY: OutboxRetryPolicy = Object.freeze({
  maxAttempts: 3,
  backoffMs: outboxRetryBackoffMs,
});

const silentLogger = {
  info() {},
  error() {},
};

type OutboxRow = {
  event_id: string;
  event_type: string;
  attempt_count: number;
  available_at: Date;
  processed_at: Date | null;
  dead_at: Date | null;
  last_error_code: string | null;
  last_failed_at: Date | null;
  lease_owner: string | null;
  leased_at: Date | null;
  lease_until: Date | null;
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

function dedicatedTestDatabaseUrl(): string {
  return resolveSafeDedicatedTestDatabaseUrl();
}

function createAdjustableClock(initial: Date) {
  let current = initial.getTime();
  return {
    now() {
      return new Date(current);
    },
    set(next: Date) {
      current = next.getTime();
    },
    addMs(ms: number) {
      current += ms;
    },
  };
}

function recordingLogger(): {
  logger: OutboxConsumerLogger;
  events: {
    level: 'info' | 'error';
    event: string;
    fields?: OutboxConsumerLogFields;
  }[];
} {
  const events: {
    level: 'info' | 'error';
    event: string;
    fields?: OutboxConsumerLogFields;
  }[] = [];
  return {
    events,
    logger: {
      info(event, fields) {
        events.push({ level: 'info', event, fields });
      },
      error(event, fields) {
        events.push({ level: 'error', event, fields });
      },
    },
  };
}

function sinkHandler(
  eventTypes: readonly string[] = [PROJECTION_V1],
): OutboxEventHandler {
  return Object.freeze({
    handlerId: 'sink',
    eventTypes,
    async handle(tx: TransactionContext, event) {
      await tx.query(
        `INSERT INTO ${SINK_TABLE} (event_id, note)
         VALUES ($1, $2)
         ON CONFLICT (event_id) DO NOTHING`,
        [event.eventId, 'ok'],
      );
    },
  });
}

function throwingSinkHandler(message: string): OutboxEventHandler {
  return Object.freeze({
    handlerId: 'throwing',
    eventTypes: [PROJECTION_V1],
    async handle(tx: TransactionContext, event) {
      await tx.query(
        `INSERT INTO ${SINK_TABLE} (event_id, note) VALUES ($1, $2)`,
        [event.eventId, 'should-roll-back'],
      );
      throw new Error(message);
    },
  });
}

function onceFailingSinkHandler(): OutboxEventHandler {
  let failed = false;
  return Object.freeze({
    handlerId: 'once_failing',
    eventTypes: [PROJECTION_V1],
    async handle(tx: TransactionContext, event) {
      if (!failed) {
        failed = true;
        await tx.query(
          `INSERT INTO ${SINK_TABLE} (event_id, note) VALUES ($1, $2)`,
          [event.eventId, 'should-roll-back'],
        );
        throw new Error('first attempt failed');
      }
      await tx.query(
        `INSERT INTO ${SINK_TABLE} (event_id, note)
         VALUES ($1, $2)
         ON CONFLICT (event_id) DO NOTHING`,
        [event.eventId, 'ok'],
      );
    },
  });
}

async function ensureSinkTable(
  query: (text: string) => Promise<unknown>,
): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS ${SINK_TABLE} (
      event_id uuid PRIMARY KEY,
      note text NOT NULL
    )
  `);
}

async function ensurePipelineTable(
  query: (text: string) => Promise<unknown>,
): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS ${PIPELINE_TABLE} (
      event_id uuid NOT NULL,
      handler_id text NOT NULL,
      PRIMARY KEY (event_id, handler_id)
    )
  `);
}

async function insertEvent(
  query: (text: string, values?: unknown[]) => Promise<unknown>,
  overrides: {
    eventId?: string;
    eventType?: string;
    availableAt?: Date;
    createdAt?: Date;
    processedAt?: Date | null;
    deadAt?: Date | null;
    attemptCount?: number;
    payload?: Record<string, unknown>;
    leaseOwner?: string | null;
    leasedAt?: Date | null;
    leaseUntil?: Date | null;
  } = {},
): Promise<string> {
  const eventId = overrides.eventId ?? createUuidV7();
  await query(
    `INSERT INTO outbox_events (
       event_id, event_type, occurred_at, created_at, available_at,
       payload, attempt_count, processed_at, dead_at,
       lease_owner, leased_at, lease_until
     ) VALUES (
       $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12
     )`,
    [
      eventId,
      overrides.eventType ?? PROJECTION_V1,
      overrides.createdAt ?? NOW,
      overrides.createdAt ?? NOW,
      overrides.availableAt ?? NOW,
      JSON.stringify(
        overrides.payload ?? {
          sentinel: SENTINEL_PAYLOAD,
          title: SENTINEL_TITLE,
          email: SENTINEL_EMAIL,
          membershipId: SENTINEL_MEMBERSHIP,
        },
      ),
      overrides.attemptCount ?? 0,
      overrides.processedAt ?? null,
      overrides.deadAt ?? null,
      overrides.leaseOwner ?? null,
      overrides.leasedAt ?? null,
      overrides.leaseUntil ?? null,
    ],
  );
  return eventId;
}

async function readEvent(
  query: (text: string, values?: unknown[]) => Promise<{ rows: OutboxRow[] }>,
  eventId: string,
): Promise<OutboxRow> {
  const result = await query(
    `SELECT event_id, event_type, attempt_count, available_at,
            processed_at, dead_at, last_error_code, last_failed_at,
            lease_owner, leased_at, lease_until
     FROM outbox_events
     WHERE event_id = $1`,
    [eventId],
  );
  const row = result.rows[0];
  assert.ok(row);
  return row;
}

void describe('outbox consumer PostgreSQL drain', () => {
  void it(
    'uses only a dedicated safe TEST_DATABASE_URL',
    { skip: skipWithoutDatabase },
    () => {
      const url = dedicatedTestDatabaseUrl();
      assert.notEqual(url.toLowerCase().includes('/roomies?'), true);
    },
  );

  void it(
    'claims an eligible event and does not reclaim processed, backoff, or dead rows',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const ids: string[] = [];
      try {
        await ensureSinkTable((text) => database.pool.query(text));
        const eligible = await insertEvent((text, values) =>
          database.pool.query(text, values ? [...values] : []),
        );
        const processed = await insertEvent(
          (text, values) =>
            database.pool.query(text, values ? [...values] : []),
          { processedAt: NOW },
        );
        const backoff = await insertEvent(
          (text, values) =>
            database.pool.query(text, values ? [...values] : []),
          { availableAt: new Date(NOW.getTime() + 60_000) },
        );
        const dead = await insertEvent(
          (text, values) =>
            database.pool.query(text, values ? [...values] : []),
          { deadAt: NOW },
        );
        ids.push(eligible, processed, backoff, dead);

        const clock = createAdjustableClock(NOW);
        const consumer = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([sinkHandler()]),
          clock,
          retryPolicy: TEST_RETRY,
          logger: silentLogger,
        });
        const result = await consumer.drain({ batchSize: 10 });
        assert.equal(result.processedCount, 1);
        assert.equal(result.failedCount, 0);
        assert.equal(result.moreWorkLikely, false);

        const eligibleRow = await readEvent(
          (text, values) => database.pool.query(text, values),
          eligible,
        );
        assert.ok(eligibleRow.processed_at);
        assert.equal(eligibleRow.lease_owner, null);

        const processedRow = await readEvent(
          (text, values) => database.pool.query(text, values),
          processed,
        );
        assert.deepEqual(
          processedRow.processed_at?.toISOString(),
          NOW.toISOString(),
        );

        const backoffRow = await readEvent(
          (text, values) => database.pool.query(text, values),
          backoff,
        );
        assert.equal(backoffRow.processed_at, null);
        assert.equal(backoffRow.attempt_count, 0);

        const deadRow = await readEvent(
          (text, values) => database.pool.query(text, values),
          dead,
        );
        assert.equal(deadRow.processed_at, null);
        assert.ok(deadRow.dead_at);
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
    'claims eligible events in deterministic oldest-first order and respects batch size',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const ids: string[] = [];
      try {
        await ensureSinkTable((text) => database.pool.query(text));
        const first = await insertEvent(
          (text, values) =>
            database.pool.query(text, values ? [...values] : []),
          {
            availableAt: new Date('2026-09-13T21:00:00.000Z'),
            createdAt: new Date('2026-09-13T21:00:00.000Z'),
          },
        );
        const second = await insertEvent(
          (text, values) =>
            database.pool.query(text, values ? [...values] : []),
          {
            availableAt: new Date('2026-09-13T21:01:00.000Z'),
            createdAt: new Date('2026-09-13T21:01:00.000Z'),
          },
        );
        const third = await insertEvent(
          (text, values) =>
            database.pool.query(text, values ? [...values] : []),
          {
            availableAt: new Date('2026-09-13T21:02:00.000Z'),
            createdAt: new Date('2026-09-13T21:02:00.000Z'),
          },
        );
        ids.push(first, second, third);

        const ordered: string[] = [];
        const consumer = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([
            Object.freeze({
              handlerId: 'ordered',
              eventTypes: [PROJECTION_V1],
              handle(_tx, event) {
                ordered.push(event.eventId);
                return Promise.resolve();
              },
            }),
          ]),
          clock: createAdjustableClock(NOW),
          retryPolicy: TEST_RETRY,
          logger: silentLogger,
        });

        const firstDrain = await consumer.drain({ batchSize: 2 });
        assert.equal(firstDrain.processedCount, 2);
        assert.equal(firstDrain.moreWorkLikely, true);
        assert.deepEqual(ordered, [first, second]);

        const secondDrain = await consumer.drain({ batchSize: 2 });
        assert.equal(secondDrain.processedCount, 1);
        assert.equal(secondDrain.moreWorkLikely, false);
        assert.deepEqual(ordered, [first, second, third]);
      } finally {
        if (ids.length > 0) {
          await database.pool.query(
            `DELETE FROM outbox_events WHERE event_id = ANY($1)`,
            [ids],
          );
        }
        await database.close();
      }
    },
  );

  void it(
    'commits handler writes with the processed marker and rolls both back on failure',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const ids: string[] = [];
      try {
        await ensureSinkTable((text) => database.pool.query(text));
        const successId = await insertEvent((text, values) =>
          database.pool.query(text, values ? [...values] : []),
        );
        const failureId = await insertEvent(
          (text, values) =>
            database.pool.query(text, values ? [...values] : []),
          { eventType: OTHER_V1 },
        );
        ids.push(successId, failureId);

        const successConsumer = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([sinkHandler()]),
          clock: createAdjustableClock(NOW),
          retryPolicy: TEST_RETRY,
          logger: silentLogger,
        });
        await successConsumer.drain({ batchSize: 10 });

        const sink = await database.pool.query<{ note: string }>(
          `SELECT note FROM ${SINK_TABLE} WHERE event_id = $1`,
          [successId],
        );
        assert.equal(sink.rows[0]?.note, 'ok');
        const successRow = await readEvent(
          (text, values) => database.pool.query(text, values),
          successId,
        );
        assert.ok(successRow.processed_at);
        assert.equal(successRow.lease_owner, null);

        const { logger, events } = recordingLogger();
        const failingConsumer = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([
            throwingSinkHandler(
              `${SENTINEL_PAYLOAD} ${SENTINEL_TITLE} ${SENTINEL_EMAIL} ${SENTINEL_MEMBERSHIP}`,
            ),
          ]),
          clock: createAdjustableClock(NOW),
          logger,
          retryPolicy: TEST_RETRY,
        });
        // Re-insert a projection event for the throwing handler.
        const poisonId = await insertEvent((text, values) =>
          database.pool.query(text, values ? [...values] : []),
        );
        ids.push(poisonId);
        const failResult = await failingConsumer.drain({ batchSize: 10 });
        assert.equal(failResult.processedCount, 0);
        assert.equal(failResult.failedCount, 1);

        const rolledBack = await database.pool.query(
          `SELECT event_id FROM ${SINK_TABLE} WHERE event_id = $1`,
          [poisonId],
        );
        assert.equal(rolledBack.rows.length, 0);
        const failedRow = await readEvent(
          (text, values) => database.pool.query(text, values),
          poisonId,
        );
        assert.equal(failedRow.processed_at, null);
        assert.equal(failedRow.attempt_count, 1);
        assert.equal(failedRow.last_error_code, 'HANDLER_FAILED');
        assert.ok(failedRow.last_failed_at);
        assert.equal(failedRow.dead_at, null);
        assert.equal(failedRow.lease_owner, null);

        const serialized = JSON.stringify(events);
        assert.equal(serialized.includes(SENTINEL_PAYLOAD), false);
        assert.equal(serialized.includes(SENTINEL_TITLE), false);
        assert.equal(serialized.includes(SENTINEL_EMAIL), false);
        assert.equal(serialized.includes(SENTINEL_MEMBERSHIP), false);
        assert.equal(serialized.includes('{'), true);
        const failureLog = events.find(
          (entry) => entry.event === 'event handler failed',
        );
        assert.equal(failureLog?.fields?.outcome, 'retry_scheduled');
        assert.equal(failureLog?.fields?.errorClass, 'Error');
        assert.equal(failureLog?.fields?.attemptCount, 1);
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
    'records failure bookkeeping once, then retries later exactly once',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const ids: string[] = [];
      try {
        await ensureSinkTable((text) => database.pool.query(text));
        const eventId = await insertEvent((text, values) =>
          database.pool.query(text, values ? [...values] : []),
        );
        ids.push(eventId);
        const clock = createAdjustableClock(NOW);
        const consumer = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([onceFailingSinkHandler()]),
          clock,
          retryPolicy: TEST_RETRY,
          logger: silentLogger,
        });

        const first = await consumer.drain({ batchSize: 5 });
        assert.equal(first.failedCount, 1);
        const afterFail = await readEvent(
          (text, values) => database.pool.query(text, values),
          eventId,
        );
        assert.equal(afterFail.attempt_count, 1);
        assert.equal(afterFail.processed_at, null);

        const immediate = await consumer.drain({ batchSize: 5 });
        assert.equal(immediate.processedCount, 0);
        assert.equal(immediate.failedCount, 0);
        assert.equal(immediate.moreWorkLikely, false);

        clock.set(afterFail.available_at);
        const second = await consumer.drain({ batchSize: 5 });
        assert.equal(second.processedCount, 1);
        assert.equal(second.failedCount, 0);

        const finalRow = await readEvent(
          (text, values) => database.pool.query(text, values),
          eventId,
        );
        assert.ok(finalRow.processed_at);
        assert.equal(finalRow.attempt_count, 1);
        const sink = await database.pool.query<{ note: string }>(
          `SELECT note FROM ${SINK_TABLE} WHERE event_id = $1`,
          [eventId],
        );
        assert.equal(sink.rows.length, 1);
        assert.equal(sink.rows[0]?.note, 'ok');
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
    'keeps repeated delivery to an idempotent handler at-least-once safe',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const ids: string[] = [];
      try {
        await ensureSinkTable((text) => database.pool.query(text));
        const eventId = await insertEvent((text, values) =>
          database.pool.query(text, values ? [...values] : []),
        );
        ids.push(eventId);
        let calls = 0;
        const consumer = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([
            Object.freeze({
              handlerId: 'idempotent',
              eventTypes: [PROJECTION_V1],
              async handle(tx: TransactionContext, event) {
                calls += 1;
                await tx.query(
                  `INSERT INTO ${SINK_TABLE} (event_id, note)
                   VALUES ($1, $2)
                   ON CONFLICT (event_id) DO NOTHING`,
                  [event.eventId, 'ok'],
                );
              },
            }),
          ]),
          clock: createAdjustableClock(NOW),
          retryPolicy: TEST_RETRY,
          logger: silentLogger,
        });
        await consumer.drain({ batchSize: 5 });
        await consumer.drain({ batchSize: 5 });
        assert.equal(calls, 1);
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
    'increments attempts until the event is permanently failed and then stops leasing',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const ids: string[] = [];
      try {
        await ensureSinkTable((text) => database.pool.query(text));
        const eventId = await insertEvent((text, values) =>
          database.pool.query(text, values ? [...values] : []),
        );
        ids.push(eventId);
        const clock = createAdjustableClock(NOW);
        let handlerCalls = 0;
        const consumer = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([
            Object.freeze({
              handlerId: 'poison',
              eventTypes: [PROJECTION_V1],
              handle() {
                handlerCalls += 1;
                return Promise.reject(new Error('poison'));
              },
            }),
          ]),
          clock,
          retryPolicy: TEST_RETRY,
          logger: silentLogger,
        });

        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const result = await consumer.drain({ batchSize: 5 });
          assert.equal(result.failedCount, 1);
          const row = await readEvent(
            (text, values) => database.pool.query(text, values),
            eventId,
          );
          assert.equal(row.attempt_count, attempt);
          if (attempt < 3) {
            assert.equal(row.dead_at, null);
            clock.set(row.available_at);
          } else {
            assert.ok(row.dead_at);
            assert.equal(row.processed_at, null);
          }
        }

        const afterDead = await consumer.drain({ batchSize: 5 });
        assert.equal(afterDead.processedCount, 0);
        assert.equal(afterDead.failedCount, 0);
        assert.equal(afterDead.moreWorkLikely, false);
        assert.equal(handlerCalls, 3);
        const sink = await database.pool.query(
          `SELECT event_id FROM ${SINK_TABLE} WHERE event_id = $1`,
          [eventId],
        );
        assert.equal(sink.rows.length, 0);
      } finally {
        if (ids.length > 0) {
          await database.pool.query(
            `DELETE FROM outbox_events WHERE event_id = ANY($1)`,
            [ids],
          );
        }
        await database.close();
      }
    },
  );

  void it(
    'dispatches the exact type, leaves unknown and version-mismatched events pending',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const ids: string[] = [];
      try {
        const matched = await insertEvent((text, values) =>
          database.pool.query(text, values ? [...values] : []),
        );
        const versionMismatch = await insertEvent(
          (text, values) =>
            database.pool.query(text, values ? [...values] : []),
          { eventType: PROJECTION_V2 },
        );
        const unknown = await insertEvent(
          (text, values) =>
            database.pool.query(text, values ? [...values] : []),
          { eventType: UNSUBSCRIBED_V1 },
        );
        ids.push(matched, versionMismatch, unknown);

        const seen: string[] = [];
        const consumer = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([
            Object.freeze({
              handlerId: 'exact',
              eventTypes: [PROJECTION_V1],
              handle(_tx, event) {
                seen.push(event.eventType);
                return Promise.resolve();
              },
            }),
          ]),
          clock: createAdjustableClock(NOW),
          retryPolicy: TEST_RETRY,
          logger: silentLogger,
        });
        const result = await consumer.drain({ batchSize: 10 });
        assert.equal(result.processedCount, 1);
        assert.deepEqual(seen, [PROJECTION_V1]);

        const mismatchRow = await readEvent(
          (text, values) => database.pool.query(text, values),
          versionMismatch,
        );
        const unknownRow = await readEvent(
          (text, values) => database.pool.query(text, values),
          unknown,
        );
        assert.equal(mismatchRow.processed_at, null);
        assert.equal(mismatchRow.dead_at, null);
        assert.equal(mismatchRow.attempt_count, 0);
        assert.equal(unknownRow.processed_at, null);
        assert.equal(unknownRow.dead_at, null);
        assert.equal(unknownRow.attempt_count, 0);
      } finally {
        if (ids.length > 0) {
          await database.pool.query(
            `DELETE FROM outbox_events WHERE event_id = ANY($1)`,
            [ids],
          );
        }
        await database.close();
      }
    },
  );

  void it(
    'stops future leases on abort while letting the in-flight transaction finish',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const ids: string[] = [];
      try {
        await ensureSinkTable((text) => database.pool.query(text));
        const first = await insertEvent(
          (text, values) =>
            database.pool.query(text, values ? [...values] : []),
          {
            availableAt: new Date('2026-09-13T21:00:00.000Z'),
            createdAt: new Date('2026-09-13T21:00:00.000Z'),
          },
        );
        const second = await insertEvent(
          (text, values) =>
            database.pool.query(text, values ? [...values] : []),
          {
            availableAt: new Date('2026-09-13T21:01:00.000Z'),
            createdAt: new Date('2026-09-13T21:01:00.000Z'),
          },
        );
        ids.push(first, second);

        let release!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        let started!: () => void;
        const inFlight = new Promise<void>((resolve) => {
          started = resolve;
        });

        const controller = new AbortController();
        const consumer = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([
            Object.freeze({
              handlerId: 'abort',
              eventTypes: [PROJECTION_V1],
              async handle(tx: TransactionContext, event) {
                started();
                await released;
                await tx.query(
                  `INSERT INTO ${SINK_TABLE} (event_id, note) VALUES ($1, $2)`,
                  [event.eventId, 'ok'],
                );
              },
            }),
          ]),
          clock: createAdjustableClock(NOW),
          retryPolicy: TEST_RETRY,
          logger: silentLogger,
        });

        const drainPromise = consumer.drain({
          batchSize: 10,
          signal: controller.signal,
        });
        await inFlight;
        controller.abort();
        release();
        const result = await drainPromise;
        assert.equal(result.processedCount, 1);
        assert.equal(result.failedCount, 0);

        const firstRow = await readEvent(
          (text, values) => database.pool.query(text, values),
          first,
        );
        const secondRow = await readEvent(
          (text, values) => database.pool.query(text, values),
          second,
        );
        assert.ok(firstRow.processed_at);
        assert.equal(secondRow.processed_at, null);
        assert.equal(secondRow.attempt_count, 0);
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
    'runs every subscribed handler in composition order and commits only after all succeed',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const ids: string[] = [];
      try {
        await ensurePipelineTable((text) => database.pool.query(text));
        const eventId = await insertEvent((text, values) =>
          database.pool.query(text, values ? [...values] : []),
        );
        ids.push(eventId);
        const order: string[] = [];
        const consumer = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([
            Object.freeze({
              handlerId: 'beta',
              eventTypes: [PROJECTION_V1],
              async handle(tx: TransactionContext, event) {
                order.push('beta');
                await tx.query(
                  `INSERT INTO ${PIPELINE_TABLE} (event_id, handler_id)
                   VALUES ($1, $2)
                   ON CONFLICT (event_id, handler_id) DO NOTHING`,
                  [event.eventId, 'beta'],
                );
              },
            }),
            Object.freeze({
              handlerId: 'alpha',
              eventTypes: [PROJECTION_V1],
              async handle(tx: TransactionContext, event) {
                order.push('alpha');
                await tx.query(
                  `INSERT INTO ${PIPELINE_TABLE} (event_id, handler_id)
                   VALUES ($1, $2)
                   ON CONFLICT (event_id, handler_id) DO NOTHING`,
                  [event.eventId, 'alpha'],
                );
              },
            }),
          ]),
          clock: createAdjustableClock(NOW),
          retryPolicy: TEST_RETRY,
          logger: silentLogger,
        });

        const result = await consumer.drain({ batchSize: 5 });
        assert.equal(result.processedCount, 1);
        assert.deepEqual(order, ['beta', 'alpha']);
        const row = await readEvent(
          (text, values) => database.pool.query(text, values),
          eventId,
        );
        assert.ok(row.processed_at);
        const sink = await database.pool.query<{ handler_id: string }>(
          `SELECT handler_id FROM ${PIPELINE_TABLE}
           WHERE event_id = $1
           ORDER BY handler_id`,
          [eventId],
        );
        assert.deepEqual(
          sink.rows.map((item) => item.handler_id),
          ['alpha', 'beta'],
        );
      } finally {
        if (ids.length > 0) {
          await database.pool.query(
            `DELETE FROM outbox_events WHERE event_id = ANY($1)`,
            [ids],
          );
          await database.pool.query(
            `DELETE FROM ${PIPELINE_TABLE} WHERE event_id = ANY($1)`,
            [ids],
          );
        }
        await database.close();
      }
    },
  );

  void it(
    'rolls back every handler write when a later handler fails, then retries the full pipeline',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const ids: string[] = [];
      try {
        await ensurePipelineTable((text) => database.pool.query(text));
        const eventId = await insertEvent((text, values) =>
          database.pool.query(text, values ? [...values] : []),
        );
        ids.push(eventId);
        let betaFailures = 0;
        const clock = createAdjustableClock(NOW);
        const consumer = createOutboxConsumerFromPool(database.pool, {
          registry: createOutboxHandlerRegistry([
            Object.freeze({
              handlerId: 'alpha',
              eventTypes: [PROJECTION_V1],
              async handle(tx: TransactionContext, event) {
                await tx.query(
                  `INSERT INTO ${PIPELINE_TABLE} (event_id, handler_id)
                   VALUES ($1, $2)
                   ON CONFLICT (event_id, handler_id) DO NOTHING`,
                  [event.eventId, 'alpha'],
                );
              },
            }),
            Object.freeze({
              handlerId: 'beta',
              eventTypes: [PROJECTION_V1],
              async handle(tx: TransactionContext, event) {
                await tx.query(
                  `INSERT INTO ${PIPELINE_TABLE} (event_id, handler_id)
                   VALUES ($1, $2)
                   ON CONFLICT (event_id, handler_id) DO NOTHING`,
                  [event.eventId, 'beta'],
                );
                if (betaFailures === 0) {
                  betaFailures += 1;
                  throw new Error('pipeline handler failed');
                }
              },
            }),
          ]),
          clock,
          retryPolicy: TEST_RETRY,
          logger: silentLogger,
        });

        const first = await consumer.drain({ batchSize: 5 });
        assert.equal(first.processedCount, 0);
        assert.equal(first.failedCount, 1);
        assert.equal(betaFailures, 1);
        const afterFail = await readEvent(
          (text, values) => database.pool.query(text, values),
          eventId,
        );
        assert.equal(afterFail.processed_at, null);
        assert.equal(afterFail.attempt_count, 1);
        const rolledBack = await database.pool.query(
          `SELECT handler_id FROM ${PIPELINE_TABLE} WHERE event_id = $1`,
          [eventId],
        );
        assert.equal(rolledBack.rows.length, 0);

        const tooEarly = await consumer.drain({ batchSize: 5 });
        assert.equal(tooEarly.processedCount, 0);
        assert.equal(tooEarly.failedCount, 0);

        clock.set(afterFail.available_at);
        const second = await consumer.drain({ batchSize: 5 });
        assert.equal(second.processedCount, 1);
        assert.equal(second.failedCount, 0);
        assert.equal(betaFailures, 1);
        const finalRow = await readEvent(
          (text, values) => database.pool.query(text, values),
          eventId,
        );
        assert.ok(finalRow.processed_at);
        assert.equal(finalRow.attempt_count, 1);
        const sink = await database.pool.query<{ handler_id: string }>(
          `SELECT handler_id FROM ${PIPELINE_TABLE}
           WHERE event_id = $1
           ORDER BY handler_id`,
          [eventId],
        );
        assert.deepEqual(
          sink.rows.map((item) => item.handler_id),
          ['alpha', 'beta'],
        );
      } finally {
        if (ids.length > 0) {
          await database.pool.query(
            `DELETE FROM outbox_events WHERE event_id = ANY($1)`,
            [ids],
          );
          await database.pool.query(
            `DELETE FROM ${PIPELINE_TABLE} WHERE event_id = ANY($1)`,
            [ids],
          );
        }
        await database.close();
      }
    },
  );
});
