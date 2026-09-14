import {
  createNotificationRepository,
  NOTIFICATION_PRUNE_BATCH_SIZE,
  NOTIFICATION_RETENTION_DAYS,
  type NotificationRepository,
} from '../../domains/notifications/repository.js';
import type {
  TransactionContext,
  TransactionPool,
} from '../../platform/persistence/transaction.js';

export type PruneExpiredNotificationsInput = Readonly<{
  now: Date;
  limit?: number;
}>;

export type PruneExpiredNotificationsResult = Readonly<{
  deletedCount: number;
  cutoff: Date;
}>;

export type PruneExpiredNotifications = (
  tx: TransactionContext,
  input: PruneExpiredNotificationsInput,
) => Promise<PruneExpiredNotificationsResult>;

const DAY_MS = 24 * 60 * 60 * 1000;

export function notificationRetentionCutoff(now: Date): Date {
  return new Date(now.getTime() - NOTIFICATION_RETENTION_DAYS * DAY_MS);
}

/**
 * Bounded retention prune. Hard-deletes rows with occurredAt < cutoff.
 * Does not own a scheduler or begin a transaction.
 */
export function createPruneExpiredNotifications(
  notifications: Pick<NotificationRepository, 'pruneExpired'>,
): PruneExpiredNotifications {
  return async (tx, input) => {
    const cutoff = notificationRetentionCutoff(input.now);
    const result = await notifications.pruneExpired(tx, {
      cutoff,
      limit: input.limit ?? NOTIFICATION_PRUNE_BATCH_SIZE,
    });
    return Object.freeze({
      deletedCount: result.deletedCount,
      cutoff,
    });
  };
}

export function createPruneExpiredNotificationsFromPool(
  pool: TransactionPool,
): PruneExpiredNotifications {
  return createPruneExpiredNotifications(
    createNotificationRepository(
      pool as Parameters<typeof createNotificationRepository>[0],
    ),
  );
}
