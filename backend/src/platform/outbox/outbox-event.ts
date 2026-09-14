import type { JsonObject } from '../events/outbox-types.js';

/**
 * Immutable application-facing outbox envelope. No Prisma row, lease fields,
 * or raw driver types.
 */
export type OutboxEvent = Readonly<{
  eventId: string;
  eventType: string;
  occurredAt: Date;
  homeId: string | null;
  attemptCount: number;
  payload: JsonObject;
}>;
