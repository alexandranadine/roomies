import type { Activity, ActivitySourceEntityType } from './activity.js';

/**
 * Safe historical roommate attribution. `name` is AuthIdentity.name when the
 * identity still exists. Missing/anonymized identity is null — the API does
 * not invent a product label.
 */
export type ActivityActorDisplay = Readonly<{
  membershipId: string;
  name: string | null;
}>;

/**
 * Recipient-safe Activity list item. No visibility class, recipients,
 * userId, Maintenance details, or audience.
 */
export type ActivityListItem = Readonly<{
  id: string;
  eventType: string;
  sourceEntityType: ActivitySourceEntityType;
  sourceEntityId: string;
  occurredAt: Date;
  actor: ActivityActorDisplay | null;
  sourceTitle: string | null;
  subject: ActivityActorDisplay | null;
}>;

export type ActivityRepositoryPage = Readonly<{
  items: readonly Activity[];
  hasMore: boolean;
  nextCursor: string | null;
}>;

export type ActivityListPage = Readonly<{
  items: readonly ActivityListItem[];
  hasMore: boolean;
  nextCursor: string | null;
}>;
