import { decideNotificationMarkOne } from '../../domains/notifications/list-policy.js';
import {
  createNotificationRepository,
  type MarkEligibleNotificationReadResult,
  type NotificationRepository,
} from '../../domains/notifications/repository.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import {
  runInReadCommittedTransaction,
  type TransactionContext,
  type TransactionPool,
} from '../../platform/persistence/transaction.js';

export type MarkNotificationReadInput = Readonly<{
  userId: string;
  notificationId: string;
}>;

export type MarkNotificationReadRepository = Pick<
  NotificationRepository,
  'markEligibleRead'
>;

export type MarkNotificationReadDependencies = Readonly<{
  notifications: MarkNotificationReadRepository;
  runTransaction: <T>(
    work: (tx: TransactionContext) => Promise<T>,
  ) => Promise<T>;
}>;

/**
 * Mark one currently eligible Notification read. Invisible rows are a
 * concealed 404. Already-read rows keep the original readAt.
 */
export async function markNotificationRead(
  input: MarkNotificationReadInput,
  deps: MarkNotificationReadDependencies,
): Promise<void> {
  const decision = decideNotificationMarkOne();
  if (!decision.allowed) {
    throw new ConcealedNotFoundError();
  }

  const result: MarkEligibleNotificationReadResult = await deps.runTransaction(
    (tx) =>
      deps.notifications.markEligibleRead(tx, {
        userId: input.userId,
        notificationId: input.notificationId,
      }),
  );
  if (result.outcome === 'not_found') {
    throw new ConcealedNotFoundError();
  }
}

export function createMarkNotificationReadFromPool(
  pool: TransactionPool,
): (input: MarkNotificationReadInput) => Promise<void> {
  return (input) =>
    markNotificationRead(input, {
      notifications: createNotificationRepository(
        pool as Parameters<typeof createNotificationRepository>[0],
      ),
      runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    });
}
