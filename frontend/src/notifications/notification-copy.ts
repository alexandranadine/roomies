import type { NotificationListItem } from './notifications-api.js';

export const NOTIFICATION_KINDS = {
  MEMBERSHIP_ROLE_CHANGED: 'MEMBERSHIP_ROLE_CHANGED',
  ASSIGNED_TASK_COMPLETED: 'ASSIGNED_TASK_COMPLETED',
  CREATED_SUPPLY_OBTAINED: 'CREATED_SUPPLY_OBTAINED',
  PRIVATE_MAINTENANCE_CREATED: 'PRIVATE_MAINTENANCE_CREATED',
  PRIVATE_MAINTENANCE_RESOLVED: 'PRIVATE_MAINTENANCE_RESOLVED',
} as const;

export type NotificationIconName =
  'shield' | 'check' | 'package' | 'wrench' | 'check-circle' | 'bell';

export type NotificationPresentation = {
  message: string;
  sourceTitle: string | null;
  icon: NotificationIconName;
};

function actorName(item: NotificationListItem): string | null {
  const trimmed = item.actor?.name.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function sourceTitle(item: NotificationListItem): string | null {
  if (item.source === null) {
    return null;
  }
  const trimmed = item.source.title.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Maps a Notification DTO to recipient-safe display copy.
 * Never exposes enum names, role internals, or protected Maintenance content.
 */
export function presentNotification(
  item: NotificationListItem,
): NotificationPresentation {
  switch (item.kind) {
    case NOTIFICATION_KINDS.MEMBERSHIP_ROLE_CHANGED:
      return {
        icon: 'shield',
        message: 'Your roommate role changed',
        sourceTitle: null,
      };
    case NOTIFICATION_KINDS.ASSIGNED_TASK_COMPLETED: {
      const actor = actorName(item);
      return {
        icon: 'check',
        message:
          actor === null
            ? 'A task assigned to you was completed'
            : `${actor} completed a task assigned to you`,
        sourceTitle: sourceTitle(item),
      };
    }
    case NOTIFICATION_KINDS.CREATED_SUPPLY_OBTAINED: {
      const actor = actorName(item);
      return {
        icon: 'package',
        message:
          actor === null
            ? 'A supply you added was picked up'
            : `${actor} picked up a supply you added`,
        sourceTitle: sourceTitle(item),
      };
    }
    case NOTIFICATION_KINDS.PRIVATE_MAINTENANCE_CREATED:
      return {
        icon: 'wrench',
        message: 'New private maintenance update',
        sourceTitle: null,
      };
    case NOTIFICATION_KINDS.PRIVATE_MAINTENANCE_RESOLVED:
      return {
        icon: 'check-circle',
        message: 'Private maintenance was resolved',
        sourceTitle: null,
      };
    default:
      return {
        icon: 'bell',
        message: 'You have a new notification',
        sourceTitle: null,
      };
  }
}
