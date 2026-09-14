export const NOTIFICATION_KINDS = [
  'MEMBERSHIP_ROLE_CHANGED',
  'ASSIGNED_TASK_COMPLETED',
  'CREATED_SUPPLY_OBTAINED',
  'PRIVATE_MAINTENANCE_CREATED',
  'PRIVATE_MAINTENANCE_RESOLVED',
] as const;

export const NOTIFICATION_SOURCE_ENTITY_TYPES = [
  'MEMBERSHIP',
  'TASK',
  'SUPPLY',
  'MAINTENANCE',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export type NotificationSourceEntityType =
  (typeof NOTIFICATION_SOURCE_ENTITY_TYPES)[number];

export const NOTIFICATION_KIND_SOURCE_TYPE = Object.freeze({
  MEMBERSHIP_ROLE_CHANGED: 'MEMBERSHIP',
  ASSIGNED_TASK_COMPLETED: 'TASK',
  CREATED_SUPPLY_OBTAINED: 'SUPPLY',
  PRIVATE_MAINTENANCE_CREATED: 'MAINTENANCE',
  PRIVATE_MAINTENANCE_RESOLVED: 'MAINTENANCE',
} as const satisfies Record<NotificationKind, NotificationSourceEntityType>);

export type Notification = Readonly<{
  id: string;
  homeId: string;
  recipientMembershipId: string;
  sourceOutboxEventId: string;
  kind: NotificationKind;
  sourceEntityType: NotificationSourceEntityType;
  sourceEntityId: string;
  actorMembershipId: string | null;
  occurredAt: Date;
  createdAt: Date;
  readAt: Date | null;
}>;

export function isNotificationKind(value: unknown): value is NotificationKind {
  return (
    value === 'MEMBERSHIP_ROLE_CHANGED' ||
    value === 'ASSIGNED_TASK_COMPLETED' ||
    value === 'CREATED_SUPPLY_OBTAINED' ||
    value === 'PRIVATE_MAINTENANCE_CREATED' ||
    value === 'PRIVATE_MAINTENANCE_RESOLVED'
  );
}

export function isNotificationSourceEntityType(
  value: unknown,
): value is NotificationSourceEntityType {
  return (
    value === 'MEMBERSHIP' ||
    value === 'TASK' ||
    value === 'SUPPLY' ||
    value === 'MAINTENANCE'
  );
}

export function isNotificationKindSourceCompatible(
  kind: NotificationKind,
  sourceEntityType: NotificationSourceEntityType,
): boolean {
  return NOTIFICATION_KIND_SOURCE_TYPE[kind] === sourceEntityType;
}
