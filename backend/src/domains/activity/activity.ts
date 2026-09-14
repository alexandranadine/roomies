export const ACTIVITY_SOURCE_ENTITY_TYPES = [
  'MEMBERSHIP',
  'TASK',
  'SUPPLY',
  'MAINTENANCE',
] as const;

export const ACTIVITY_VISIBILITY_CLASSES = [
  'HOME_VISIBLE',
  'SOURCE_AUTHORIZED',
] as const;

export const MAX_ACTIVITY_EVENT_TYPE_LENGTH = 200;

export type ActivitySourceEntityType =
  (typeof ACTIVITY_SOURCE_ENTITY_TYPES)[number];

export type ActivityVisibilityClass =
  (typeof ACTIVITY_VISIBILITY_CLASSES)[number];

export type Activity = Readonly<{
  id: string;
  homeId: string;
  sourceOutboxEventId: string;
  sourceEntityType: ActivitySourceEntityType;
  sourceEntityId: string;
  eventType: string;
  visibilityClass: ActivityVisibilityClass;
  actorMembershipId: string | null;
  occurredAt: Date;
  createdAt: Date;
}>;

export type ActivityRecipient = Readonly<{
  homeId: string;
  activityId: string;
  membershipId: string;
  createdAt: Date;
}>;

export function isActivitySourceEntityType(
  value: unknown,
): value is ActivitySourceEntityType {
  return (
    value === 'MEMBERSHIP' ||
    value === 'TASK' ||
    value === 'SUPPLY' ||
    value === 'MAINTENANCE'
  );
}

export function isActivityVisibilityClass(
  value: unknown,
): value is ActivityVisibilityClass {
  return value === 'HOME_VISIBLE' || value === 'SOURCE_AUTHORIZED';
}

export function isValidActivityEventType(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_ACTIVITY_EVENT_TYPE_LENGTH
  );
}
