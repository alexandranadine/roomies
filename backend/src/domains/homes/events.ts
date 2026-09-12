import type { OutboxEventInput } from '../../platform/events/outbox-types.js';

export const HOME_ARCHIVED_V1 = 'home.archived.v1';

export type HomeArchivedV1Payload = Readonly<{
  homeId: string;
}>;

export function createHomeArchivedV1Event(
  input: Readonly<{
    eventId: string;
    occurredAt: Date;
    homeId: string;
  }>,
): OutboxEventInput<typeof HOME_ARCHIVED_V1, HomeArchivedV1Payload> {
  return Object.freeze({
    eventId: input.eventId,
    eventType: HOME_ARCHIVED_V1,
    occurredAt: input.occurredAt,
    homeId: input.homeId,
    payload: Object.freeze({ homeId: input.homeId }),
  });
}
