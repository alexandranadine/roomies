import { decideHomeChangePhoto } from '../../domains/homes/policies.js';
import {
  createHomePhotoPointerWriter,
  type HomePhotoPointerWriter,
} from '../../domains/homes/photo-pointer.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import type { HomePhotoObjectStore } from '../../platform/object-store/index.js';
import {
  runInReadCommittedTransaction,
  type TransactionContext,
  type TransactionPool,
} from '../../platform/persistence/transaction.js';
import { bestEffortDeleteHomePhotoObject } from './home-photo-cleanup.js';

export type DeleteHomePhotoInput = Readonly<{
  actor: ActiveHomeActor;
  homeId: string;
}>;

export type DeleteHomePhotoDependencies = Readonly<{
  runTransaction: <T>(
    work: (tx: TransactionContext) => Promise<T>,
  ) => Promise<T>;
  pointers: HomePhotoPointerWriter;
  objectStore: Pick<HomePhotoObjectStore, 'deleteObject'>;
}>;

/**
 * Clear the Home photo pointer under the Home row lock. Object deletion runs
 * only after commit, and only for the exact previous key captured by this
 * transaction.
 */
export function createDeleteHomePhoto(
  deps: DeleteHomePhotoDependencies,
): (input: DeleteHomePhotoInput) => Promise<void> {
  return async (input) => {
    const decision = decideHomeChangePhoto({
      actor: input.actor,
      targetHomeId: input.homeId,
    });
    if (!decision.allowed) {
      throw new ConcealedNotFoundError();
    }

    const previousPhotoObjectKey = await deps.runTransaction(async (tx) => {
      const locked = await deps.pointers.lockActiveHomeForPhotoMutation(tx, {
        homeId: input.homeId,
        actor: input.actor,
      });
      if (locked.home.id !== input.homeId) {
        throw new ConcealedNotFoundError();
      }
      const lockedDecision = decideHomeChangePhoto({
        actor: locked.actor,
        targetHomeId: locked.home.id,
      });
      if (!lockedDecision.allowed) {
        throw new ConcealedNotFoundError();
      }

      const previous = locked.home.photoObjectKey;
      await deps.pointers.clearPhotoPointer(tx, { homeId: locked.home.id });
      return previous;
    });

    await bestEffortDeleteHomePhotoObject(
      deps.objectStore,
      previousPhotoObjectKey,
    );
  };
}

export function createDeleteHomePhotoFromPool(
  pool: TransactionPool,
  objectStore: Pick<HomePhotoObjectStore, 'deleteObject'>,
): ReturnType<typeof createDeleteHomePhoto> {
  return createDeleteHomePhoto({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    pointers: createHomePhotoPointerWriter(),
    objectStore,
  });
}
