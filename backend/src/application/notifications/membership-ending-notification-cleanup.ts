import type { MembershipEndedCause } from '../../domains/memberships/events.js';
import {
  createNotificationRepository,
  type NotificationRepository,
} from '../../domains/notifications/repository.js';
import type {
  TransactionContext,
  TransactionPool,
} from '../../platform/persistence/transaction.js';

/**
 * Notifications-owned public seam for synchronous membership-ending cleanup.
 * Callers must already hold Home/Membership structural locks and pass the
 * existing transaction. Deletes only rows addressed to the exact ending
 * Membership tenure. Actor-only rows are preserved.
 *
 * Does not begin, commit, or roll back a transaction. Does not emit
 * Notification events. Does not lock Home or Membership.
 */
export type MembershipEndingNotificationCleanupInput = Readonly<{
  homeId: string;
  membershipId: string;
  endedAt: Date;
  cause: MembershipEndedCause;
}>;

export type MembershipEndingNotificationCleanup = Readonly<{
  handleMembershipEnded(
    tx: TransactionContext,
    input: MembershipEndingNotificationCleanupInput,
  ): Promise<void>;
}>;

export type MembershipEndingNotificationCleanupNotifications = Pick<
  NotificationRepository,
  'deleteByRecipientMembership'
>;

export function createMembershipEndingNotificationCleanup(
  notifications: MembershipEndingNotificationCleanupNotifications,
): MembershipEndingNotificationCleanup {
  return Object.freeze({
    async handleMembershipEnded(tx, input) {
      await notifications.deleteByRecipientMembership(tx, {
        homeId: input.homeId,
        recipientMembershipId: input.membershipId,
      });
    },
  });
}

export function createMembershipEndingNotificationCleanupFromPool(
  pool: TransactionPool,
): MembershipEndingNotificationCleanup {
  return createMembershipEndingNotificationCleanup(
    createNotificationRepository(
      pool as Parameters<typeof createNotificationRepository>[0],
    ),
  );
}
