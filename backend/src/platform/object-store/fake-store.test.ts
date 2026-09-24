import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCanonicalHomePhotoObjectKey } from '../../domains/homes/photo-object-key.js';
import { createTempHomePhotoObjectKey } from '../../domains/homes/temp-photo-object-key.js';
import {
  InvalidObjectStoreRequestError,
  ObjectNotFoundError,
  ObjectStoreInfrastructureError,
  ObjectTooLargeError,
} from './errors.js';
import { createFakeHomePhotoObjectStore } from './fake-store.js';
import { MAX_UPLOAD_BYTES } from './types.js';

const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FIXED_ID = '11111111-1111-4111-8111-111111111111';

void describe('fake Home photo object store', () => {
  void it('seeds, stores, retrieves, and deletes objects', async () => {
    const store = createFakeHomePhotoObjectStore();
    const tempKey = createTempHomePhotoObjectKey(HOME_ID, () => FIXED_ID);
    const canonicalKey = createCanonicalHomePhotoObjectKey(
      HOME_ID,
      () => FIXED_ID,
    );
    const bytes = Buffer.from('temp-bytes');
    store.seed(tempKey, bytes);
    const read = await store.getObjectBounded({ key: tempKey });
    assert.deepEqual(Buffer.from(read), bytes);

    await store.putCanonicalObject({
      homeId: HOME_ID,
      key: canonicalKey,
      body: Buffer.from('canonical-webp'),
    });
    assert.deepEqual(
      Buffer.from(store.getStored(canonicalKey) ?? []),
      Buffer.from('canonical-webp'),
    );

    await store.deleteObject({ key: tempKey });
    assert.equal(store.getStored(tempKey), undefined);
    await assert.rejects(
      () => store.getObjectBounded({ key: tempKey }),
      ObjectNotFoundError,
    );
  });

  void it('records calls and injects get/put/delete/sign failures', async () => {
    const store = createFakeHomePhotoObjectStore();
    const tempKey = createTempHomePhotoObjectKey(HOME_ID, () => FIXED_ID);
    const canonicalKey = createCanonicalHomePhotoObjectKey(
      HOME_ID,
      () => FIXED_ID,
    );
    store.seed(tempKey, Buffer.from('x'));

    store.failNext('get');
    await assert.rejects(
      () => store.getObjectBounded({ key: tempKey }),
      ObjectStoreInfrastructureError,
    );
    store.failNext('put');
    await assert.rejects(
      () =>
        store.putCanonicalObject({
          homeId: HOME_ID,
          key: canonicalKey,
          body: Buffer.from('y'),
        }),
      ObjectStoreInfrastructureError,
    );
    store.failNext('delete');
    await assert.rejects(
      () => store.deleteObject({ key: tempKey }),
      ObjectStoreInfrastructureError,
    );
    store.failNext('signPut');
    await assert.rejects(
      () =>
        store.createPresignedPut({
          homeId: HOME_ID,
          key: tempKey,
          contentType: 'image/jpeg',
        }),
      ObjectStoreInfrastructureError,
    );
    store.failNext('signGet');
    await assert.rejects(
      () => store.createPresignedGet({ homeId: HOME_ID, key: canonicalKey }),
      ObjectStoreInfrastructureError,
    );

    assert.deepEqual(store.calls.get, [tempKey]);
    assert.deepEqual(store.calls.put, [canonicalKey]);
    assert.deepEqual(store.calls.delete, [tempKey]);
    assert.deepEqual(store.calls.signPut, [tempKey]);
    assert.deepEqual(store.calls.signGet, [canonicalKey]);
  });

  void it('does not sign unauthorized temp or canonical keys', async () => {
    const store = createFakeHomePhotoObjectStore();
    const tempKey = createTempHomePhotoObjectKey(HOME_ID, () => FIXED_ID);
    const canonicalKey = createCanonicalHomePhotoObjectKey(
      HOME_ID,
      () => FIXED_ID,
    );

    await assert.rejects(
      () =>
        store.createPresignedPut({
          homeId: OTHER_HOME_ID,
          key: tempKey,
          contentType: 'image/jpeg',
        }),
      InvalidObjectStoreRequestError,
    );
    await assert.rejects(
      () =>
        store.createPresignedGet({
          homeId: HOME_ID,
          key: tempKey,
        }),
      InvalidObjectStoreRequestError,
    );
    await assert.rejects(
      () =>
        store.putCanonicalObject({
          homeId: HOME_ID,
          key: tempKey,
          body: Buffer.from('nope'),
        }),
      InvalidObjectStoreRequestError,
    );
    await assert.rejects(
      () =>
        store.createPresignedGet({
          homeId: OTHER_HOME_ID,
          key: canonicalKey,
        }),
      InvalidObjectStoreRequestError,
    );
  });

  void it('rejects oversized seeded objects using untrusted metadata first', async () => {
    const store = createFakeHomePhotoObjectStore();
    const key = createTempHomePhotoObjectKey(HOME_ID, () => FIXED_ID);
    store.seed(key, Buffer.alloc(16, 1), MAX_UPLOAD_BYTES + 1);
    await assert.rejects(
      () => store.getObjectBounded({ key }),
      ObjectTooLargeError,
    );
  });
});
