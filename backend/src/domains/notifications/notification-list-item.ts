import type { Notification, NotificationKind } from './notification.js';

export type NotificationHomeDisplay = Readonly<{
  id: string;
  name: string;
}>;

export type NotificationActorDisplay = Readonly<{
  name: string;
}>;

export type NotificationSourcePresentation =
  | Readonly<{ type: 'TASK'; title: string }>
  | Readonly<{ type: 'SUPPLY'; title: string }>
  | null;

export type NotificationDestination =
  | Readonly<{ type: 'TASK'; homeId: string; taskInstanceId: string }>
  | Readonly<{ type: 'SUPPLY'; homeId: string; supplyEntryId: string }>
  | Readonly<{ type: 'ROOMMATES'; homeId: string }>
  | Readonly<{ type: 'HOME'; homeId: string }>;

/**
 * Recipient-safe Notification list item. No Membership IDs, account
 * identifiers, email, capability, internal source IDs for PRIVATE
 * Maintenance, or outbox IDs.
 */
export type NotificationListItem = Readonly<{
  id: string;
  kind: NotificationKind;
  occurredAt: Date;
  readAt: Date | null;
  home: NotificationHomeDisplay;
  actor: NotificationActorDisplay | null;
  source: NotificationSourcePresentation;
  destination: NotificationDestination;
}>;

export type EligibleNotification = Notification &
  Readonly<{
    homeName: string;
  }>;

export type NotificationRepositoryPage = Readonly<{
  items: readonly EligibleNotification[];
  hasMore: boolean;
  nextCursor: string | null;
}>;

export type NotificationListPage = Readonly<{
  items: readonly NotificationListItem[];
  hasMore: boolean;
  nextCursor: string | null;
}>;
