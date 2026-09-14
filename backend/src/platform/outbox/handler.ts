import type { TransactionContext } from '../persistence/transaction.js';
import type { OutboxEvent } from './outbox-event.js';

/**
 * Stable composition identity for one projection pipeline participant.
 * Uniqueness is (handlerId, eventType), not eventType alone.
 */
export const OUTBOX_HANDLER_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Application handler invoked inside the caller's outbox claim transaction.
 * Must not open an independent transaction.
 */
export type OutboxEventHandler = Readonly<{
  handlerId: string;
  eventTypes: readonly string[];
  handle(tx: TransactionContext, event: OutboxEvent): Promise<void>;
}>;
