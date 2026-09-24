import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  AuthorizationIntegrityError,
  ConcealedNotFoundError,
} from '../../platform/authz/errors.js';
import { createFakeHomePhotoObjectStore } from '../../platform/object-store/index.js';
import { createCanonicalHomePhotoObjectKey } from '../../domains/homes/photo-object-key.js';
import { createGetHomePhoto } from './get-home-photo.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBERSHIP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const GENERATION_ID = '33333333-3333-4333-8333-333333333333';
const FIXED_NOW = new Date('2026-09-23T18:00:00.000Z');

function actor(): ActiveHomeActor {
  return {
    userId: USER_ID,
    membershipId: MEMBERSHIP_ID,
    homeId: HOME_ID,
    role: 'ROOMMATE',
  };
}

void describe('createGetHomePhoto', () => {
  void it('returns null without signing when the pointer is empty', async () => {
    const store = createFakeHomePhotoObjectStore({ now: () => FIXED_NOW });
    const getPhoto = createGetHomePhoto({
      homes: {
        findActiveHomeById: () =>
          Promise.resolve({
            id: HOME_ID,
            name: 'Oak Street',
            timezone: 'UTC',
            photoObjectKey: null,
          }),
      },
      objectStore: store,
    });
    const result = await getPhoto({ actor: actor(), homeId: HOME_ID });
    assert.equal(result, null);
    assert.deepEqual(store.calls.signGet, []);
  });

  void it('signs a canonical pointer after authorization', async () => {
    const key = createCanonicalHomePhotoObjectKey(HOME_ID, () => GENERATION_ID);
    const store = createFakeHomePhotoObjectStore({ now: () => FIXED_NOW });
    const getPhoto = createGetHomePhoto({
      homes: {
        findActiveHomeById: () =>
          Promise.resolve({
            id: HOME_ID,
            name: 'Oak Street',
            timezone: 'UTC',
            photoObjectKey: key,
          }),
      },
      objectStore: store,
    });
    const result = await getPhoto({ actor: actor(), homeId: HOME_ID });
    assert.ok(result);
    assert.equal(result.contentType, 'image/webp');
    assert.equal(store.calls.signGet.includes(key), true);
  });

  void it('fails closed on a non-canonical stored key without signing', async () => {
    const store = createFakeHomePhotoObjectStore({ now: () => FIXED_NOW });
    const getPhoto = createGetHomePhoto({
      homes: {
        findActiveHomeById: () =>
          Promise.resolve({
            id: HOME_ID,
            name: 'Oak Street',
            timezone: 'UTC',
            photoObjectKey: `tmp/homes/${HOME_ID}/photo/${GENERATION_ID}`,
          }),
      },
      objectStore: store,
    });
    await assert.rejects(
      () => getPhoto({ actor: actor(), homeId: HOME_ID }),
      AuthorizationIntegrityError,
    );
    assert.deepEqual(store.calls.signGet, []);
  });

  void it('conceals a Home-scope mismatch without signing', async () => {
    const store = createFakeHomePhotoObjectStore();
    const getPhoto = createGetHomePhoto({
      homes: {
        findActiveHomeById: () =>
          Promise.reject(new Error('must not read Home on policy deny')),
      },
      objectStore: store,
    });
    await assert.rejects(
      () => getPhoto({ actor: actor(), homeId: OTHER_HOME_ID }),
      ConcealedNotFoundError,
    );
    assert.deepEqual(store.calls.signGet, []);
  });
});
