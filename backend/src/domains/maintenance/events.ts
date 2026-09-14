import type { OutboxEventInput } from '../../platform/events/outbox-types.js';

export const MAINTENANCE_CREATED_V1 = 'maintenance.created.v1';
export const MAINTENANCE_RESOLVED_V1 = 'maintenance.resolved.v1';

export type MaintenanceCreatedV1Payload = Readonly<{
  maintenanceEntryId: string;
}>;

export type MaintenanceResolvedV1Payload = Readonly<{
  maintenanceEntryId: string;
}>;

export function createMaintenanceCreatedV1Event(
  input: Readonly<{
    eventId: string;
    occurredAt: Date;
    homeId: string;
    maintenanceEntryId: string;
  }>,
): OutboxEventInput<
  typeof MAINTENANCE_CREATED_V1,
  MaintenanceCreatedV1Payload
> {
  return Object.freeze({
    eventId: input.eventId,
    eventType: MAINTENANCE_CREATED_V1,
    occurredAt: input.occurredAt,
    homeId: input.homeId,
    payload: Object.freeze({
      maintenanceEntryId: input.maintenanceEntryId,
    }),
  });
}

export function createMaintenanceResolvedV1Event(
  input: Readonly<{
    eventId: string;
    occurredAt: Date;
    homeId: string;
    maintenanceEntryId: string;
  }>,
): OutboxEventInput<
  typeof MAINTENANCE_RESOLVED_V1,
  MaintenanceResolvedV1Payload
> {
  return Object.freeze({
    eventId: input.eventId,
    eventType: MAINTENANCE_RESOLVED_V1,
    occurredAt: input.occurredAt,
    homeId: input.homeId,
    payload: Object.freeze({
      maintenanceEntryId: input.maintenanceEntryId,
    }),
  });
}
