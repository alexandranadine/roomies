import type { Home } from '../../domains/homes/home.js';
import {
  isCanonicalHomePhotoObjectKey,
  storedHomePhotoObjectKey,
} from '../../domains/homes/photo-object-key.js';
import type {
  HomePhotoPointerWriter,
  LockedHomePhotoMutation,
} from '../../domains/homes/photo-pointer.js';
import { isTempHomePhotoObjectKey } from '../../domains/homes/temp-photo-object-key.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  AuthorizationIntegrityError,
  ConcealedNotFoundError,
} from '../../platform/authz/errors.js';
import { TransactionInfrastructureError } from '../../platform/persistence/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import type { HomePhotoImageProcessor } from '../../platform/image/index.js';

export type MemoryHomePhotoState = {
  home: Home;
  actor: ActiveHomeActor;
  archived: boolean;
  membershipEnded: boolean;
};

const unusedTx = {
  query: () => Promise.reject(new Error('memory photo pointer does not query')),
} as unknown as TransactionContext;

export function createMemoryHomePhotoState(input: {
  home: Home;
  actor: ActiveHomeActor;
}): MemoryHomePhotoState {
  return {
    home: { ...input.home },
    actor: { ...input.actor },
    archived: false,
    membershipEnded: false,
  };
}

export function createMemoryHomePhotoPointers(
  state: MemoryHomePhotoState,
  options: {
    onLock?: () => Promise<void>;
    failReplace?: boolean;
  } = {},
): HomePhotoPointerWriter {
  return {
    async lockActiveHomeForPhotoMutation(_tx, input) {
      if (options.onLock) {
        await options.onLock();
      }
      if (state.archived || input.homeId !== state.home.id) {
        throw new ConcealedNotFoundError();
      }
      if (
        state.membershipEnded ||
        input.actor.membershipId !== state.actor.membershipId ||
        input.actor.userId !== state.actor.userId ||
        input.actor.homeId !== state.home.id
      ) {
        throw new ConcealedNotFoundError();
      }
      return Object.freeze({
        home: Object.freeze({ ...state.home }),
        actor: Object.freeze({ ...state.actor }),
      }) as LockedHomePhotoMutation;
    },
    async replacePhotoPointer(_tx, input) {
      if (options.failReplace === true) {
        throw new TransactionInfrastructureError();
      }
      if (
        isTempHomePhotoObjectKey(input.photoObjectKey, input.homeId) ||
        !isCanonicalHomePhotoObjectKey(input.photoObjectKey, input.homeId)
      ) {
        throw new AuthorizationIntegrityError();
      }
      storedHomePhotoObjectKey(input.photoObjectKey, input.homeId);
      state.home = {
        ...state.home,
        photoObjectKey: input.photoObjectKey,
      };
    },
    async clearPhotoPointer(_tx, input) {
      if (input.homeId !== state.home.id || state.archived) {
        throw new TransactionInfrastructureError();
      }
      state.home = { ...state.home, photoObjectKey: null };
    },
  };
}

export function createMemoryPhotoTransaction(
  state: MemoryHomePhotoState,
  options: { failCommit?: boolean } = {},
) {
  return async <T>(
    work: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> => {
    const snapshot: MemoryHomePhotoState = {
      home: { ...state.home },
      actor: { ...state.actor },
      archived: state.archived,
      membershipEnded: state.membershipEnded,
    };
    try {
      const result = await work(unusedTx);
      if (options.failCommit === true) {
        state.home = snapshot.home;
        state.actor = snapshot.actor;
        state.archived = snapshot.archived;
        state.membershipEnded = snapshot.membershipEnded;
        throw new TransactionInfrastructureError();
      }
      return result;
    } catch (error) {
      state.home = snapshot.home;
      state.actor = snapshot.actor;
      state.archived = snapshot.archived;
      state.membershipEnded = snapshot.membershipEnded;
      throw error;
    }
  };
}

export function recordingProcessor(
  inner: HomePhotoImageProcessor = {
    process: (input) =>
      Promise.resolve({
        bytes: input,
        width: 32,
        height: 32,
        contentType: 'image/webp',
      }),
  },
): HomePhotoImageProcessor & { readonly calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    process(input) {
      calls += 1;
      return inner.process(input);
    },
  };
}
