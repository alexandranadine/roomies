import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  InvalidHomePhotoObjectKeyInputError,
  isCanonicalHomePhotoObjectKey,
} from './photo-object-key.js';
import {
  TEMP_HOME_PHOTO_OBJECT_KEY_PATTERN,
  createTempHomePhotoObjectKey,
  isTempHomePhotoObjectKey,
} from './temp-photo-object-key.js';

const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UPLOAD_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

void describe('createTempHomePhotoObjectKey', () => {
  void it('creates tmp/homes/{home UUID}/photo/{upload UUID}', () => {
    const key = createTempHomePhotoObjectKey(HOME_ID, () => UPLOAD_ID);
    assert.equal(key, `tmp/homes/${HOME_ID}/photo/${UPLOAD_ID}`);
    assert.equal(isTempHomePhotoObjectKey(key, HOME_ID), true);
    const match = TEMP_HOME_PHOTO_OBJECT_KEY_PATTERN.exec(key);
    assert.ok(match);
    assert.equal(match[1], HOME_ID);
    assert.equal(match[2], UPLOAD_ID);
  });

  void it('mints upload IDs as lowercase UUIDs without identity data', () => {
    const key = createTempHomePhotoObjectKey(HOME_ID);
    const match = TEMP_HOME_PHOTO_OBJECT_KEY_PATTERN.exec(key);
    assert.ok(match);
    assert.equal(match[1], HOME_ID);
    assert.match(
      match[2] ?? '',
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    assert.equal(key.includes(USER_ID), false);
    assert.equal(key.includes('membership'), false);
    assert.equal(key.includes('email'), false);
    assert.equal(key.includes('@'), false);
    assert.equal(key.includes('token'), false);
  });

  void it('never passes the canonical Home photo key validator', () => {
    const key = createTempHomePhotoObjectKey(HOME_ID, () => UPLOAD_ID);
    assert.equal(isCanonicalHomePhotoObjectKey(key, HOME_ID), false);
    assert.equal(isCanonicalHomePhotoObjectKey(`${key}.webp`, HOME_ID), false);
  });

  void it('rejects non-UUID Home IDs and other Homes', () => {
    assert.throws(
      () => createTempHomePhotoObjectKey('not-a-uuid'),
      InvalidHomePhotoObjectKeyInputError,
    );
    const key = createTempHomePhotoObjectKey(HOME_ID, () => UPLOAD_ID);
    assert.equal(isTempHomePhotoObjectKey(key, OTHER_HOME_ID), false);
  });
});
