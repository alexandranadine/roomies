import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import { createFakeHomePhotoObjectStore } from '../../platform/object-store/index.js';
import { createCanonicalHomePhotoObjectKey } from '../../domains/homes/photo-object-key.js';
import type { Home } from '../../domains/homes/home.js';
import { createDeleteHomePhoto } from './delete-home-photo.js';
import {
  createMemoryHomePhotoPointers,
  createMemoryHomePhotoState,
  createMemoryPhotoTransaction,
} from './home-photo.test-helpers.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBERSHIP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const GENERATION_ID = '33333333-3333-4333-8333-333333333333';

function actor(role: ActiveHomeActor['role'] = 'ROOMMATE'): ActiveHomeActor {
  return {
    userId: USER_ID,
    membershipId: MEMBERSHIP_ID,
    homeId: HOME_ID,
    role,
  };
}

function home(photoObjectKey: string | null): Home {
  return {
    id: HOME_ID,
    name: 'Oak Street',
    timezone: 'UTC',
    photoObjectKey,
  };
}

void describe('createDeleteHomePhoto', () => {
  void it('clears the pointer then deletes the captured previous object', async () => {
    const previous = createCanonicalHomePhotoObjectKey(
      HOME_ID,
      () => GENERATION_ID,
    );
    const store = createFakeHomePhotoObjectStore();
    store.seed(previous, Buffer.from('old'));
    const state = createMemoryHomePhotoState({
      home: home(previous),
      actor: actor(),
    });
    const deletes: string[] = [];
    const deletePhoto = createDeleteHomePhoto({
      runTransaction: async (work) => {
        const result = await createMemoryPhotoTransaction(state)(work);
        assert.equal(state.home.photoObjectKey, null);
        assert.equal(deletes.length, 0);
        return result;
      },
      pointers: createMemoryHomePhotoPointers(state),
      objectStore: {
        async deleteObject(input) {
          deletes.push(input.key);
          await store.deleteObject(input);
        },
      },
    });
    await deletePhoto({ actor: actor(), homeId: HOME_ID });
    assert.deepEqual(deletes, [previous]);
    assert.equal(store.getStored(previous), undefined);
  });

  void it('does not call DeleteObject when the pointer is already null', async () => {
    const store = createFakeHomePhotoObjectStore();
    const state = createMemoryHomePhotoState({
      home: home(null),
      actor: actor('ADMIN'),
    });
    const deletePhoto = createDeleteHomePhoto({
      runTransaction: createMemoryPhotoTransaction(state),
      pointers: createMemoryHomePhotoPointers(state),
      objectStore: store,
    });
    await deletePhoto({ actor: actor('ADMIN'), homeId: HOME_ID });
    await deletePhoto({ actor: actor('ADMIN'), homeId: HOME_ID });
    assert.deepEqual(store.calls.delete, []);
  });

  void it('leaves the pointer and object intact when the transaction fails', async () => {
    const previous = createCanonicalHomePhotoObjectKey(
      HOME_ID,
      () => GENERATION_ID,
    );
    const store = createFakeHomePhotoObjectStore();
    store.seed(previous, Buffer.from('old'));
    const state = createMemoryHomePhotoState({
      home: home(previous),
      actor: actor(),
    });
    const deletePhoto = createDeleteHomePhoto({
      runTransaction: createMemoryPhotoTransaction(state, { failCommit: true }),
      pointers: createMemoryHomePhotoPointers(state),
      objectStore: store,
    });
    await assert.rejects(
      () => deletePhoto({ actor: actor(), homeId: HOME_ID }),
      Error,
    );
    assert.equal(state.home.photoObjectKey, previous);
    assert.ok(store.getStored(previous));
    assert.deepEqual(store.calls.delete, []);
  });

  void it('conceals a Home-scope mismatch without deleting', async () => {
    const store = createFakeHomePhotoObjectStore();
    const state = createMemoryHomePhotoState({
      home: home(null),
      actor: actor(),
    });
    const deletePhoto = createDeleteHomePhoto({
      runTransaction: createMemoryPhotoTransaction(state),
      pointers: createMemoryHomePhotoPointers(state),
      objectStore: store,
    });
    await assert.rejects(
      () =>
        deletePhoto({
          actor: { ...actor(), homeId: OTHER_HOME_ID },
          homeId: HOME_ID,
        }),
      ConcealedNotFoundError,
    );
    assert.deepEqual(store.calls.delete, []);
  });
});
