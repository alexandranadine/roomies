import type { JsonObject } from '../events/outbox-types.js';
import type { UuidV7Generator } from '../ids/uuid-v7.js';
import { systemUuidV7 } from '../ids/uuid-v7.js';
import {
  runInReadCommittedTransaction,
  type TransactionContext,
  type TransactionPool,
} from '../persistence/transaction.js';
import type { Clock } from '../time/clock.js';
import { systemClock } from '../time/clock.js';
import {
  createConsoleOutboxLogger,
  outboxErrorClassOf,
  type OutboxConsumerLogger,
} from './logging.js';
import type { OutboxEvent } from './outbox-event.js';
import type { OutboxHandlerRegistry } from './registry.js';
import {
  DEFAULT_OUTBOX_BATCH_SIZE,
  DEFAULT_OUTBOX_LEASE_DURATION_MS,
  defaultOutboxRetryPolicy,
  OUTBOX_HANDLER_FAILED_ERROR_CODE,
  type OutboxRetryPolicy,
} from './retry-policy.js';

export const HANDLER_SAVEPOINT = 'outbox_event_handler';

/**
 * Claim one eligible subscribed event, lock it for this transaction, and
 * stamp lease fields. Eligibility excludes processed, dead, not-yet-available,
 * and unexpired committed leases. Unsubscribed types are never selected.
 */
export const CLAIM_OUTBOX_EVENT_SQL = `
WITH picked AS (
  SELECT event_id
  FROM outbox_events
  WHERE processed_at IS NULL
    AND dead_at IS NULL
    AND available_at <= $1::timestamptz
    AND (lease_until IS NULL OR lease_until <= $1::timestamptz)
    AND event_type = ANY($2::text[])
  ORDER BY available_at ASC, created_at ASC, event_id ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
UPDATE outbox_events AS claimed
SET
  lease_owner = $3::uuid,
  leased_at = $1::timestamptz,
  lease_until = $4::timestamptz
FROM picked
WHERE claimed.event_id = picked.event_id
RETURNING
  claimed.event_id,
  claimed.event_type,
  claimed.occurred_at,
  claimed.home_id,
  claimed.payload,
  claimed.attempt_count
`;

export const MARK_OUTBOX_EVENT_PROCESSED_SQL = `
UPDATE outbox_events
SET
  processed_at = $2::timestamptz,
  lease_owner = NULL,
  leased_at = NULL,
  lease_until = NULL
WHERE event_id = $1::uuid
  AND processed_at IS NULL
  AND dead_at IS NULL
`;

export const RECORD_OUTBOX_EVENT_FAILURE_SQL = `
UPDATE outbox_events
SET
  attempt_count = attempt_count + 1,
  last_failed_at = $2::timestamptz,
  last_error_code = $3::varchar,
  available_at = $4::timestamptz,
  dead_at = $5::timestamptz,
  lease_owner = NULL,
  leased_at = NULL,
  lease_until = NULL
WHERE event_id = $1::uuid
  AND processed_at IS NULL
  AND dead_at IS NULL
`;

export type DrainOutboxOptions = Readonly<{
  batchSize?: number;
  signal?: AbortSignal;
}>;

export type DrainOutboxResult = Readonly<{
  processedCount: number;
  failedCount: number;
  moreWorkLikely: boolean;
}>;

export type OutboxConsumer = Readonly<{
  drain(options?: DrainOutboxOptions): Promise<DrainOutboxResult>;
}>;

export type OutboxConsumerDependencies = Readonly<{
  runTransaction: <T>(
    work: (tx: TransactionContext) => Promise<T>,
  ) => Promise<T>;
  registry: OutboxHandlerRegistry;
  clock?: Clock;
  ids?: UuidV7Generator;
  logger?: OutboxConsumerLogger;
  retryPolicy?: OutboxRetryPolicy;
  leaseDurationMs?: number;
}>;

type ClaimedOutboxRow = Readonly<{
  event_id: string;
  event_type: string;
  occurred_at: Date;
  home_id: string | null;
  payload: unknown;
  attempt_count: number;
}>;

type ProcessOneResult = 'empty' | 'processed' | 'failed';

function positiveInteger(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError('Outbox drain limits must be positive integers');
  }
  return resolved;
}

function isPlainJsonObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function toOutboxEvent(row: ClaimedOutboxRow): OutboxEvent | null {
  if (!isPlainJsonObject(row.payload)) {
    return null;
  }
  const occurredAt =
    row.occurred_at instanceof Date
      ? new Date(row.occurred_at.getTime())
      : new Date(row.occurred_at);
  if (!Number.isFinite(occurredAt.getTime())) {
    return null;
  }
  return Object.freeze({
    eventId: row.event_id,
    eventType: row.event_type,
    occurredAt,
    homeId: row.home_id,
    attemptCount: row.attempt_count,
    payload: Object.freeze({ ...row.payload }),
  });
}

async function claimEvent(
  tx: TransactionContext,
  input: {
    now: Date;
    eventTypes: readonly string[];
    leaseOwner: string;
    leaseUntil: Date;
  },
): Promise<ClaimedOutboxRow | null> {
  const result = await tx.query<ClaimedOutboxRow>(CLAIM_OUTBOX_EVENT_SQL, [
    input.now,
    input.eventTypes,
    input.leaseOwner,
    input.leaseUntil,
  ]);
  return result.rows[0] ?? null;
}

async function markProcessed(
  tx: TransactionContext,
  eventId: string,
  now: Date,
): Promise<void> {
  const result = await tx.query(MARK_OUTBOX_EVENT_PROCESSED_SQL, [
    eventId,
    now,
  ]);
  if (result.rowCount !== 1) {
    throw new Error('Outbox processed marker did not update one row');
  }
}

async function recordFailure(
  tx: TransactionContext,
  eventId: string,
  attemptCount: number,
  now: Date,
  retryPolicy: OutboxRetryPolicy,
): Promise<'retry_scheduled' | 'permanently_failed'> {
  const nextAttempt = attemptCount + 1;
  const permanentlyFailed = nextAttempt >= retryPolicy.maxAttempts;
  const availableAt = permanentlyFailed
    ? now
    : new Date(now.getTime() + retryPolicy.backoffMs(nextAttempt));
  const result = await tx.query(RECORD_OUTBOX_EVENT_FAILURE_SQL, [
    eventId,
    now,
    OUTBOX_HANDLER_FAILED_ERROR_CODE,
    availableAt,
    permanentlyFailed ? now : null,
  ]);
  if (result.rowCount !== 1) {
    throw new Error('Outbox failure bookkeeping did not update one row');
  }
  return permanentlyFailed ? 'permanently_failed' : 'retry_scheduled';
}

/**
 * Generic transactional-outbox drain. One event per READ COMMITTED
 * transaction: SKIP LOCKED claim, every registered handler for that exact
 * type, then processed marker. Any handler failure rolls back all projection
 * writes via savepoint, then records retry/dead metadata in the same
 * transaction while the row lock is held.
 *
 * Delivery model is a global dispatcher (one processed_at). All handlers for
 * a type share the caller TransactionContext and commit together. Unsubscribed
 * types stay pending so a later subsystem can register on this dispatcher.
 *
 * processed_at is terminal. A projection added in a later release cannot
 * consume events already marked processed. All projections intended for an
 * event at emit time must be registered in the same deployed composition.
 * There is no historical replay.
 */
export function createOutboxConsumer(
  deps: OutboxConsumerDependencies,
): OutboxConsumer {
  const clock = deps.clock ?? systemClock;
  const ids = deps.ids ?? systemUuidV7;
  const logger = deps.logger ?? createConsoleOutboxLogger();
  const retryPolicy = deps.retryPolicy ?? defaultOutboxRetryPolicy;
  const leaseDurationMs = positiveInteger(
    deps.leaseDurationMs,
    DEFAULT_OUTBOX_LEASE_DURATION_MS,
  );
  const leaseOwner = ids.next();
  const eventTypes = deps.registry.eventTypes;

  async function processOne(now: Date): Promise<ProcessOneResult> {
    return deps.runTransaction(async (tx) => {
      const row = await claimEvent(tx, {
        now,
        eventTypes,
        leaseOwner,
        leaseUntil: new Date(now.getTime() + leaseDurationMs),
      });
      if (row === null) {
        return 'empty';
      }

      const startedAt = now.getTime();
      const handlers = deps.registry.handlersFor(row.event_type);
      const duration = () => Math.max(0, clock.now().getTime() - startedAt);

      if (handlers.length === 0) {
        logger.error('event skipped unsubscribed', {
          eventId: row.event_id,
          eventType: row.event_type,
          attemptCount: row.attempt_count,
        });
        throw new Error('Claimed outbox event has no registered handler');
      }

      const event = toOutboxEvent(row);
      if (event === null) {
        const outcome = await recordFailure(
          tx,
          row.event_id,
          row.attempt_count,
          clock.now(),
          retryPolicy,
        );
        logger.error('event handler failed', {
          eventId: row.event_id,
          eventType: row.event_type,
          attemptCount: row.attempt_count + 1,
          outcome,
          durationMs: duration(),
          errorClass: 'InvalidPayload',
        });
        return 'failed';
      }

      await tx.query(`SAVEPOINT ${HANDLER_SAVEPOINT}`);
      try {
        for (const handler of handlers) {
          await handler.handle(tx, event);
        }
        await markProcessed(tx, event.eventId, clock.now());
        await tx.query(`RELEASE SAVEPOINT ${HANDLER_SAVEPOINT}`);
        logger.info('event processed', {
          eventId: event.eventId,
          eventType: event.eventType,
          attemptCount: event.attemptCount,
          outcome: 'processed',
          durationMs: duration(),
        });
        return 'processed';
      } catch (error: unknown) {
        await tx.query(`ROLLBACK TO SAVEPOINT ${HANDLER_SAVEPOINT}`);
        const outcome = await recordFailure(
          tx,
          event.eventId,
          event.attemptCount,
          clock.now(),
          retryPolicy,
        );
        logger.error('event handler failed', {
          eventId: event.eventId,
          eventType: event.eventType,
          attemptCount: event.attemptCount + 1,
          outcome,
          durationMs: duration(),
          errorClass: outboxErrorClassOf(error),
        });
        return 'failed';
      }
    });
  }

  return Object.freeze({
    async drain(options: DrainOutboxOptions = {}) {
      const batchSize = positiveInteger(
        options.batchSize,
        DEFAULT_OUTBOX_BATCH_SIZE,
      );
      if (eventTypes.length === 0) {
        return Object.freeze({
          processedCount: 0,
          failedCount: 0,
          moreWorkLikely: false,
        });
      }

      let processedCount = 0;
      let failedCount = 0;

      for (let index = 0; index < batchSize; index += 1) {
        if (options.signal?.aborted) {
          return Object.freeze({
            processedCount,
            failedCount,
            moreWorkLikely: true,
          });
        }

        const now = clock.now();
        if (Number.isNaN(now.valueOf())) {
          throw new RangeError('Clock returned an invalid outbox timestamp');
        }

        const outcome = await processOne(now);
        if (outcome === 'empty') {
          return Object.freeze({
            processedCount,
            failedCount,
            moreWorkLikely: false,
          });
        }
        if (outcome === 'processed') {
          processedCount += 1;
        } else {
          failedCount += 1;
        }
      }

      return Object.freeze({
        processedCount,
        failedCount,
        moreWorkLikely: true,
      });
    },
  });
}

export function createOutboxConsumerFromPool(
  pool: TransactionPool,
  deps: Omit<OutboxConsumerDependencies, 'runTransaction'>,
): OutboxConsumer {
  return createOutboxConsumer({
    ...deps,
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
  });
}
