import type { TransactionContext } from '../persistence/transaction.js';
import type { JsonObject, OutboxEventInput } from './outbox-types.js';
import { validateOutboxEventInput } from './outbox-validation.js';

export const APPEND_OUTBOX_EVENT_SQL = `
INSERT INTO outbox_events (
  event_id,
  event_type,
  occurred_at,
  home_id,
  payload
)
VALUES (
  $1::uuid,
  $2::varchar,
  $3::timestamptz,
  $4::uuid,
  $5::jsonb
)
`;

export interface OutboxWriter {
  append<TType extends string, TPayload extends JsonObject>(
    tx: TransactionContext,
    event: OutboxEventInput<TType, TPayload>,
  ): Promise<void>;
}

/**
 * Same-transaction outbox append. Uses the caller's TransactionContext only.
 * Does not acquire a pool client or own transaction lifecycle.
 */
export function createOutboxWriter(): OutboxWriter {
  const writer: OutboxWriter = {
    async append(tx, event) {
      const validated = validateOutboxEventInput(event);
      await tx.query(APPEND_OUTBOX_EVENT_SQL, [
        validated.eventId,
        validated.eventType,
        validated.occurredAt,
        validated.homeId,
        validated.payloadJson,
      ]);
    },
  };
  return Object.freeze(writer);
}

export const outboxWriter: OutboxWriter = createOutboxWriter();
