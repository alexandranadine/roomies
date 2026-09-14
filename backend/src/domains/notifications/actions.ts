export const NOTIFICATION_ACTION = {
  list: 'notification.list',
  markRead: 'notification.mark_read',
  readAll: 'notification.read_all',
} as const;

export type NotificationAction =
  (typeof NOTIFICATION_ACTION)[keyof typeof NOTIFICATION_ACTION];
