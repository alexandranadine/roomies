import {
  createCanonicalHomePhotoObjectKey,
  isCanonicalHomePhotoObjectKey,
} from '../../domains/homes/photo-object-key.js';
import { decideHomeChangePhoto } from '../../domains/homes/policies.js';
import {
  createHomePhotoPointerWriter,
  type HomePhotoPointerWriter,
  type LockedHomePhotoMutation,
} from '../../domains/homes/photo-pointer.js';
import { createTempHomePhotoObjectKey } from '../../domains/homes/temp-photo-object-key.js';
import type { Home } from '../../domains/homes/home.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  AuthorizationIntegrityError,
  ConcealedNotFoundError,
} from '../../platform/authz/errors.js';
import type { HomePhotoImageProcessor } from '../../platform/image/index.js';
import type { HomePhotoObjectStore } from '../../platform/object-store/index.js';
import {
  runInReadCommittedTransaction,
  type TransactionContext,
  type TransactionPool,
} from '../../platform/persistence/transaction.js';
import { bestEffortDeleteHomePhotoObject } from './home-photo-cleanup.js';
import {
  mapHomePhotoImageError,
  mapHomePhotoObjectReadError,
} from './map-home-photo-errors.js';

export type FinalizeHomePhotoInput = Readonly<{
  actor: ActiveHomeActor;
  homeId: string;
  uploadId: string;
}>;

export type FinalizeHomePhotoDependencies = Readonly<{
  runTransaction: <T>(
    work: (tx: TransactionContext) => Promise<T>,
  ) => Promise<T>;
  pointers: HomePhotoPointerWriter;
  objectStore: HomePhotoObjectStore;
  imageProcessor: HomePhotoImageProcessor;
  generateCanonicalKey?: (homeId: string) => string;
}>;

type CommittedPhotoReplacement = Readonly<{
  home: Home;
  previousPhotoObjectKey: string | null;
  newPhotoObjectKey: string;
}>;

function recheckedActor(
  locked: LockedHomePhotoMutation,
  input: FinalizeHomePhotoInput,
): ActiveHomeActor {
  if (locked.home.id !== input.homeId) {
    throw new ConcealedNotFoundError();
  }
  if (
    locked.actor.membershipId !== input.actor.membershipId ||
    locked.actor.userId !== input.actor.userId ||
    locked.actor.homeId !== input.homeId
  ) {
    throw new ConcealedNotFoundError();
  }
  return locked.actor;
}

/**
 * Finalize a client upload into a canonical Home photo.
 *
 * Frozen order: authorize → bounded temp read + Sharp + canonical PutObject
 * outside the DB lock → short Home FOR UPDATE transaction → post-commit
 * cleanup of only this request's temp key and captured previous pointer.
 */
export function createFinalizeHomePhoto(
  deps: FinalizeHomePhotoDependencies,
): (input: FinalizeHomePhotoInput) => Promise<Home> {
  const generateCanonicalKey =
    deps.generateCanonicalKey ?? createCanonicalHomePhotoObjectKey;

  return async (input) => {
    const decision = decideHomeChangePhoto({
      actor: input.actor,
      targetHomeId: input.homeId,
    });
    if (!decision.allowed) {
      throw new ConcealedNotFoundError();
    }

    const uploadId = input.uploadId.toLowerCase();
    const tempKey = createTempHomePhotoObjectKey(input.homeId, () => uploadId);

    let bytes: Uint8Array;
    try {
      bytes = await deps.objectStore.getObjectBounded({ key: tempKey });
    } catch (error) {
      await bestEffortDeleteHomePhotoObject(deps.objectStore, tempKey);
      mapHomePhotoObjectReadError(error);
    }

    let processed;
    try {
      processed = await deps.imageProcessor.process(bytes);
    } catch (error) {
      await bestEffortDeleteHomePhotoObject(deps.objectStore, tempKey);
      mapHomePhotoImageError(error);
    }

    const canonicalKey = generateCanonicalKey(input.homeId);
    if (
      !isCanonicalHomePhotoObjectKey(canonicalKey, input.homeId) ||
      canonicalKey.startsWith('tmp/')
    ) {
      await bestEffortDeleteHomePhotoObject(deps.objectStore, tempKey);
      throw new AuthorizationIntegrityError();
    }

    try {
      await deps.objectStore.putCanonicalObject({
        homeId: input.homeId,
        key: canonicalKey,
        body: processed.bytes,
      });
    } catch (error) {
      await bestEffortDeleteHomePhotoObject(deps.objectStore, tempKey);
      throw error;
    }

    let committed: CommittedPhotoReplacement;
    try {
      committed = await deps.runTransaction(async (tx) => {
        const locked = await deps.pointers.lockActiveHomeForPhotoMutation(tx, {
          homeId: input.homeId,
          actor: input.actor,
        });
        const actor = recheckedActor(locked, input);
        const lockedDecision = decideHomeChangePhoto({
          actor,
          targetHomeId: locked.home.id,
        });
        if (!lockedDecision.allowed) {
          throw new ConcealedNotFoundError();
        }

        await deps.pointers.replacePhotoPointer(tx, {
          homeId: locked.home.id,
          photoObjectKey: canonicalKey,
        });

        return Object.freeze({
          home: Object.freeze({
            id: locked.home.id,
            name: locked.home.name,
            timezone: locked.home.timezone,
            photoObjectKey: canonicalKey,
          }),
          previousPhotoObjectKey: locked.home.photoObjectKey,
          newPhotoObjectKey: canonicalKey,
        });
      });
    } catch (error) {
      await bestEffortDeleteHomePhotoObject(deps.objectStore, canonicalKey);
      await bestEffortDeleteHomePhotoObject(deps.objectStore, tempKey);
      throw error;
    }

    await bestEffortDeleteHomePhotoObject(deps.objectStore, tempKey);
    if (
      committed.previousPhotoObjectKey !== null &&
      committed.previousPhotoObjectKey !== committed.newPhotoObjectKey
    ) {
      await bestEffortDeleteHomePhotoObject(
        deps.objectStore,
        committed.previousPhotoObjectKey,
      );
    }

    return committed.home;
  };
}

export function createFinalizeHomePhotoFromPool(
  pool: TransactionPool,
  deps: {
    objectStore: HomePhotoObjectStore;
    imageProcessor: HomePhotoImageProcessor;
    generateCanonicalKey?: (homeId: string) => string;
  },
): ReturnType<typeof createFinalizeHomePhoto> {
  return createFinalizeHomePhoto({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    pointers: createHomePhotoPointerWriter(),
    objectStore: deps.objectStore,
    imageProcessor: deps.imageProcessor,
    generateCanonicalKey: deps.generateCanonicalKey,
  });
}
