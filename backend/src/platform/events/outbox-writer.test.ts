import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OutboxEventValidationError } from './errors.js';
import type { OutboxEventInput } from './outbox-types.js';
import {
  APPEND_OUTBOX_EVENT_SQL,
  createOutboxWriter,
} from './outbox-writer.js';
import type { TransactionContext } from '../persistence/transaction.js';

const UUID_V7 = '018f1e2c-7e3a-7000-8000-1234567890ab';
const OCCURRED_AT = new Date('2026-03-15T12:34:56.789Z');

const validEvent: OutboxEventInput<
  'membership.ended.v1',
  { membershipId: string }
> = {
  eventId: UUID_V7,
  eventType: 'membership.ended.v1',
  occurredAt: OCCURRED_AT,
  payload: { membershipId: UUID_V7 },
};

function fakeTx(
  onQuery: (text: string, values?: readonly unknown[]) => void = () =>
    undefined,
): TransactionContext {
  return Object.freeze({
    query<T = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ) {
      onQuery(text, values);
      return Promise.resolve({ rows: [] as T[], rowCount: 1 });
    },
  });
}

void describe('OutboxWriter.append', () => {
  void it('issues exactly one parameterized INSERT on the provided TransactionContext', async () => {
    const queries: { text: string; values: readonly unknown[] | undefined }[] =
      [];
    const tx = fakeTx((text, values) => {
      queries.push({ text, values });
    });

    await createOutboxWriter().append(tx, validEvent);

    assert.equal(queries.length, 1);
    assert.equal(queries[0]?.text, APPEND_OUTBOX_EVENT_SQL);
    assert.deepEqual(queries[0]?.values, [
      UUID_V7,
      'membership.ended.v1',
      OCCURRED_AT,
      null,
      JSON.stringify({ membershipId: UUID_V7 }),
    ]);
  });

  void it('does not call pool.connect or start a transaction', async () => {
    let connectCalls = 0;
    const pool = {
      connect() {
        connectCalls += 1;
        return Promise.reject(new Error('pool.connect must not run'));
      },
    };

    const tx = fakeTx();
    await createOutboxWriter().append(tx, validEvent);

    assert.equal(connectCalls, 0);
    await assert.rejects(
      () => pool.connect(),
      (error: unknown) =>
        error instanceof Error && error.message === 'pool.connect must not run',
    );
  });

  void it('receives the exact same TransactionContext as a domain-style writer', async () => {
    const tx = fakeTx();
    const seen: TransactionContext[] = [];

    function domainWrite(context: TransactionContext): Promise<void> {
      seen.push(context);
      return Promise.resolve();
    }

    await domainWrite(tx);
    await createOutboxWriter().append(tx, validEvent);

    assert.equal(seen.length, 1);
    assert.equal(seen[0], tx);
  });

  void it('does not INSERT when validation fails', async () => {
    let queryCalls = 0;
    const tx = fakeTx(() => {
      queryCalls += 1;
    });

    await assert.rejects(
      () =>
        createOutboxWriter().append(tx, {
          ...validEvent,
          eventId: 'not-a-uuid',
        }),
      (error: unknown) => {
        assert.ok(error instanceof OutboxEventValidationError);
        assert.equal(error.reason, 'INVALID_EVENT_ID');
        return true;
      },
    );
    assert.equal(queryCalls, 0);
  });

  void it('does not convert a PostgreSQL write failure into a validation error', async () => {
    const pgError = new Error('duplicate key value violates unique constraint');
    const tx: TransactionContext = {
      query() {
        return Promise.reject(pgError);
      },
    };

    await assert.rejects(
      () => createOutboxWriter().append(tx, validEvent),
      (error: unknown) => {
        assert.equal(error, pgError);
        assert.equal(error instanceof OutboxEventValidationError, false);
        return true;
      },
    );
  });
});
