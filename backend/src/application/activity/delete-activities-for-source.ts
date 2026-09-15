import {
  createActivityRepository,
  type ActivityRepository,
} from '../../domains/activity/repository.js';
import type {
  TransactionContext,
  TransactionPool,
} from '../../platform/persistence/transaction.js';

/**
 * Activity-owned public erasure port for a single Home/source pair.
 * Deletes ActivityRecipient rows first, then Activity rows. ActivityRecipient
 * FK is ON DELETE RESTRICT, so cascade cannot be used. Uses the caller-owned
 * transaction only.
 */
export type DeleteActivitiesForSourceInput = Readonly<{
  homeId: string;
  sourceEntityType: 'MAINTENANCE';
  sourceEntityId: string;
}>;

export type DeleteActivitiesForSource = (
  tx: TransactionContext,
  input: DeleteActivitiesForSourceInput,
) => Promise<void>;

export type DeleteActivitiesForSourceHooks = Readonly<{
  afterRecipientsDeleted?: (tx: TransactionContext) => Promise<void>;
  afterActivitiesDeleted?: (tx: TransactionContext) => Promise<void>;
}>;

export function createDeleteActivitiesForSource(
  activity: Pick<
    ActivityRepository,
    'deleteRecipientsBySource' | 'deleteActivitiesBySource'
  >,
  hooks: DeleteActivitiesForSourceHooks = {},
): DeleteActivitiesForSource {
  return async (tx, input) => {
    await activity.deleteRecipientsBySource(tx, {
      homeId: input.homeId,
      sourceEntityType: input.sourceEntityType,
      sourceEntityId: input.sourceEntityId,
    });
    await hooks.afterRecipientsDeleted?.(tx);
    await activity.deleteActivitiesBySource(tx, {
      homeId: input.homeId,
      sourceEntityType: input.sourceEntityType,
      sourceEntityId: input.sourceEntityId,
    });
    await hooks.afterActivitiesDeleted?.(tx);
  };
}

export function createDeleteActivitiesForSourceFromPool(
  pool: TransactionPool,
  hooks: DeleteActivitiesForSourceHooks = {},
): DeleteActivitiesForSource {
  return createDeleteActivitiesForSource(
    createActivityRepository(
      pool as Parameters<typeof createActivityRepository>[0],
    ),
    hooks,
  );
}
