import {
  MAX_OUTBOX_EVENT_TYPE_LENGTH,
  OUTBOX_EVENT_TYPE_PATTERN,
} from '../events/outbox-validation.js';
import {
  DuplicateOutboxHandlerRegistrationError,
  InvalidOutboxHandlerRegistrationError,
} from './errors.js';
import {
  OUTBOX_HANDLER_ID_PATTERN,
  type OutboxEventHandler,
} from './handler.js';

export type OutboxHandlerRegistry = Readonly<{
  eventTypes: readonly string[];
  handlersFor(eventType: string): readonly OutboxEventHandler[];
}>;

function isExactEventType(eventType: string): boolean {
  return (
    eventType.length > 0 &&
    eventType.length <= MAX_OUTBOX_EVENT_TYPE_LENGTH &&
    OUTBOX_EVENT_TYPE_PATTERN.test(eventType)
  );
}

function isHandlerId(handlerId: string): boolean {
  return OUTBOX_HANDLER_ID_PATTERN.test(handlerId);
}

/**
 * Exact-type handler lists in composition order. Duplicate
 * (handlerId, eventType) pairs are rejected at composition. Distinct handler
 * identities may share an event type. No prefix, wildcard, or reflection
 * matching.
 *
 * Global processed_at is terminal: a projection registered in a later
 * deployment cannot consume events already marked processed. All projections
 * intended for an event must be registered on the same deployed dispatcher.
 * There is no historical replay.
 */
export function createOutboxHandlerRegistry(
  handlers: readonly OutboxEventHandler[],
): OutboxHandlerRegistry {
  const byType = new Map<string, OutboxEventHandler[]>();
  const seenPairs = new Set<string>();

  for (const handler of handlers) {
    if (!isHandlerId(handler.handlerId) || handler.eventTypes.length === 0) {
      throw new InvalidOutboxHandlerRegistrationError();
    }

    const seenInHandler = new Set<string>();
    for (const eventType of handler.eventTypes) {
      if (!isExactEventType(eventType) || seenInHandler.has(eventType)) {
        throw new InvalidOutboxHandlerRegistrationError();
      }
      seenInHandler.add(eventType);
      const pair = `${handler.handlerId}\0${eventType}`;
      if (seenPairs.has(pair)) {
        throw new DuplicateOutboxHandlerRegistrationError(
          handler.handlerId,
          eventType,
        );
      }
      seenPairs.add(pair);
      const list = byType.get(eventType);
      if (list === undefined) {
        byType.set(eventType, [handler]);
      } else {
        list.push(handler);
      }
    }
  }

  const eventTypes = Object.freeze([...byType.keys()]);

  return Object.freeze({
    eventTypes,
    handlersFor(eventType: string) {
      const list = byType.get(eventType);
      if (list === undefined) {
        return Object.freeze([]);
      }
      return Object.freeze([...list]);
    },
  });
}
