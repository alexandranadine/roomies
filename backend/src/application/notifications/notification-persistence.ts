import type { Notification } from '../../domains/notifications/notification.js';
import {
  createNotificationRepository,
  type NewNotification,
  type NotificationInsertResult,
  type NotificationRepository,
  type NotificationSourceKey,
} from '../../domains/notifications/repository.js';
import type {
  TransactionContext,
  TransactionPool,
} from '../../platform/persistence/transaction.js';

/**
 * Narrow write/lookup port for the later Notification outbox consumer.
 * Siblings must not import the Notification repository.
 */
export type NotificationPersistence = Readonly<{
  insertNotification(
    tx: TransactionContext,
    notification: NewNotification,
  ): Promise<NotificationInsertResult>;
  insertNotifications(
    tx: TransactionContext,
    notifications: readonly NewNotification[],
  ): Promise<readonly NotificationInsertResult[]>;
  findBySourceRecipientKind(
    tx: TransactionContext,
    key: NotificationSourceKey,
  ): Promise<Notification | null>;
}>;

export function createNotificationPersistence(
  notifications: Pick<
    NotificationRepository,
    'insertNotification' | 'insertNotifications' | 'findBySourceRecipientKind'
  >,
): NotificationPersistence {
  return Object.freeze({
    insertNotification: (tx, notification) =>
      notifications.insertNotification(tx, notification),
    insertNotifications: (tx, rows) =>
      notifications.insertNotifications(tx, rows),
    findBySourceRecipientKind: (tx, key) =>
      notifications.findBySourceRecipientKind(tx, key),
  });
}

export function createNotificationPersistenceFromPool(
  pool: TransactionPool,
): NotificationPersistence {
  return createNotificationPersistence(
    createNotificationRepository(
      pool as Parameters<typeof createNotificationRepository>[0],
    ),
  );
}
