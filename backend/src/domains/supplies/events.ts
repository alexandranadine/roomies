import type { OutboxEventInput } from '../../platform/events/outbox-types.js';

export const SUPPLY_OBTAINED_V1 = 'supply.obtained.v1';

export type SupplyObtainedV1Payload = Readonly<{
  supplyEntryId: string;
}>;

export function createSupplyObtainedV1Event(
  input: Readonly<{
    eventId: string;
    occurredAt: Date;
    homeId: string;
    supplyEntryId: string;
  }>,
): OutboxEventInput<typeof SUPPLY_OBTAINED_V1, SupplyObtainedV1Payload> {
  return Object.freeze({
    eventId: input.eventId,
    eventType: SUPPLY_OBTAINED_V1,
    occurredAt: input.occurredAt,
    homeId: input.homeId,
    payload: Object.freeze({
      supplyEntryId: input.supplyEntryId,
    }),
  });
}
