import {
  createNotificationRepository,
  type NotificationRepository,
} from '../../domains/notifications/repository.js';
import type {
  TransactionContext,
  TransactionPool,
} from '../../platform/persistence/transaction.js';

/**
 * Notifications-owned public erasure port for a single Home/source pair.
 * Canonical Maintenance erasure does not exist yet; later tickets invoke this
 * inside that future same-transaction erase. Does not delete Maintenance rows.
 */
export type DeleteNotificationsForSourceInput = Readonly<{
  homeId: string;
  sourceEntityType: 'MAINTENANCE';
  sourceEntityId: string;
}>;

export type DeleteNotificationsForSource = (
  tx: TransactionContext,
  input: DeleteNotificationsForSourceInput,
) => Promise<number>;

export function createDeleteNotificationsForSource(
  notifications: Pick<NotificationRepository, 'deleteBySource'>,
): DeleteNotificationsForSource {
  return async (tx, input) =>
    notifications.deleteBySource(tx, {
      homeId: input.homeId,
      sourceEntityType: input.sourceEntityType,
      sourceEntityId: input.sourceEntityId,
    });
}

export function createDeleteNotificationsForSourceFromPool(
  pool: TransactionPool,
): DeleteNotificationsForSource {
  return createDeleteNotificationsForSource(
    createNotificationRepository(
      pool as Parameters<typeof createNotificationRepository>[0],
    ),
  );
}
