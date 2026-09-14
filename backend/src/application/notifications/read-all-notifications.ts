import { LOCK_HOME_FOR_UPDATE_SQL } from '../../domains/homes/lock-home-structure.js';
import { LOCK_EXACT_MEMBERSHIP_FOR_UPDATE_SQL } from '../../domains/homes/lock-home-and-exact-memberships.js';
import { decideNotificationReadAll } from '../../domains/notifications/list-policy.js';
import {
  createNotificationRepository,
  type ActiveRecipientTenure,
  type NotificationRepository,
} from '../../domains/notifications/repository.js';
import { TransactionInfrastructureError } from '../../platform/persistence/errors.js';
import { runWithBoundedSerializationRetry } from '../../platform/persistence/serialization-retry.js';
import {
  runInRepeatableReadTransaction,
  type TransactionContext,
  type TransactionPool,
} from '../../platform/persistence/transaction.js';

export type ReadAllNotificationsInput = Readonly<{
  userId: string;
}>;

export type ReadAllNotificationsRepository = Pick<
  NotificationRepository,
  | 'readTransactionTimestamp'
  | 'findActiveRecipientTenures'
  | 'readAllEligibleUnread'
>;

export type ReadAllNotificationsDependencies = Readonly<{
  notifications: ReadAllNotificationsRepository;
  lockHomeForUpdate: (tx: TransactionContext, homeId: string) => Promise<void>;
  lockMembershipForUpdate: (
    tx: TransactionContext,
    membershipId: string,
  ) => Promise<void>;
  runRepeatableRead: <T>(
    work: (tx: TransactionContext) => Promise<T>,
  ) => Promise<T>;
}>;

function uniqueSorted(ids: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(ids)].sort());
}

async function lockApplicableTenures(
  tx: TransactionContext,
  tenures: readonly ActiveRecipientTenure[],
  deps: ReadAllNotificationsDependencies,
): Promise<void> {
  const homeIds = uniqueSorted(tenures.map((tenure) => tenure.homeId));
  const membershipIds = uniqueSorted(
    tenures.map((tenure) => tenure.membershipId),
  );
  for (const homeId of homeIds) {
    await deps.lockHomeForUpdate(tx, homeId);
  }
  for (const membershipId of membershipIds) {
    await deps.lockMembershipForUpdate(tx, membershipId);
  }
}

/**
 * Bounded REPEATABLE READ read-all. First statement obtains readThrough.
 * Homes lock ascending, then recipient Memberships ascending, then a
 * visibility-first unread update using createdAt <= readThrough.
 */
export async function readAllNotifications(
  input: ReadAllNotificationsInput,
  deps: ReadAllNotificationsDependencies,
): Promise<void> {
  const decision = decideNotificationReadAll();
  if (!decision.allowed) {
    return;
  }

  await runWithBoundedSerializationRetry(() =>
    deps.runRepeatableRead(async (tx) => {
      const readThrough = await deps.notifications.readTransactionTimestamp(tx);
      const tenures = await deps.notifications.findActiveRecipientTenures(
        tx,
        input.userId,
      );
      await lockApplicableTenures(tx, tenures, deps);
      await deps.notifications.readAllEligibleUnread(tx, {
        userId: input.userId,
        readThrough,
      });
    }),
  );
}

async function lockRow(
  tx: TransactionContext,
  sql: string,
  id: string,
): Promise<void> {
  try {
    await tx.query(sql, [id]);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '40001'
    ) {
      throw error;
    }
    throw new TransactionInfrastructureError();
  }
}

export function createReadAllNotificationsFromPool(
  pool: TransactionPool,
): (input: ReadAllNotificationsInput) => Promise<void> {
  const notifications = createNotificationRepository(
    pool as Parameters<typeof createNotificationRepository>[0],
  );
  return (input) =>
    readAllNotifications(input, {
      notifications,
      lockHomeForUpdate: (tx, homeId) =>
        lockRow(tx, LOCK_HOME_FOR_UPDATE_SQL, homeId),
      lockMembershipForUpdate: (tx, membershipId) =>
        lockRow(tx, LOCK_EXACT_MEMBERSHIP_FOR_UPDATE_SQL, membershipId),
      runRepeatableRead: (work) => runInRepeatableReadTransaction(pool, work),
    });
}
