import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import { createFakeHomePhotoObjectStore } from '../../platform/object-store/index.js';
import { createTempHomePhotoObjectKey } from '../../domains/homes/temp-photo-object-key.js';
import { createRequestHomePhotoUpload } from './request-home-photo-upload.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBERSHIP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const UPLOAD_ID = '22222222-2222-4222-8222-222222222222';
const FIXED_NOW = new Date('2026-09-23T18:00:00.000Z');

function actor(role: ActiveHomeActor['role'] = 'ROOMMATE'): ActiveHomeActor {
  return {
    userId: USER_ID,
    membershipId: MEMBERSHIP_ID,
    homeId: HOME_ID,
    role,
  };
}

void describe('createRequestHomePhotoUpload', () => {
  void it('mints a temp key from the authorized Home and upload id', async () => {
    const store = createFakeHomePhotoObjectStore({ now: () => FIXED_NOW });
    const request = createRequestHomePhotoUpload({
      objectStore: store,
      generateUploadId: () => UPLOAD_ID,
    });
    const result = await request({
      actor: actor(),
      homeId: HOME_ID,
      contentType: 'image/jpeg',
    });
    assert.equal(result.uploadId, UPLOAD_ID);
    assert.equal(result.contentType, 'image/jpeg');
    assert.deepEqual(store.calls.signPut, [
      createTempHomePhotoObjectKey(HOME_ID, () => UPLOAD_ID),
    ]);
    assert.equal(JSON.stringify(result).includes('photoObjectKey'), false);
  });

  void it('does not sign when authorization is denied', async () => {
    const store = createFakeHomePhotoObjectStore();
    const request = createRequestHomePhotoUpload({ objectStore: store });
    await assert.rejects(
      () =>
        request({
          actor: { ...actor('ADMIN'), homeId: OTHER_HOME_ID },
          homeId: HOME_ID,
          contentType: 'image/png',
        }),
      ConcealedNotFoundError,
    );
    assert.deepEqual(store.calls.signPut, []);
  });
});
