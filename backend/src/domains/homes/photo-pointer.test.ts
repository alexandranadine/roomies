import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuthorizationIntegrityError } from '../../platform/authz/errors.js';
import { createCanonicalHomePhotoObjectKey } from './photo-object-key.js';
import { createTempHomePhotoObjectKey } from './temp-photo-object-key.js';
import {
  CLEAR_HOME_PHOTO_POINTER_SQL,
  LOCK_ACTIVE_HOME_PHOTO_FOR_UPDATE_SQL,
  REPLACE_HOME_PHOTO_POINTER_SQL,
  replaceHomePhotoPointer,
} from './photo-pointer.js';

const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

void describe('Home photo pointer SQL', () => {
  void it('locks the active Home row including the photo pointer', () => {
    assert.match(LOCK_ACTIVE_HOME_PHOTO_FOR_UPDATE_SQL, /FROM homes/i);
    assert.match(LOCK_ACTIVE_HOME_PHOTO_FOR_UPDATE_SQL, /photo_object_key/);
    assert.match(LOCK_ACTIVE_HOME_PHOTO_FOR_UPDATE_SQL, /archived_at IS NULL/);
    assert.match(LOCK_ACTIVE_HOME_PHOTO_FOR_UPDATE_SQL, /FOR UPDATE/i);
    assert.doesNotMatch(
      LOCK_ACTIVE_HOME_PHOTO_FOR_UPDATE_SQL,
      /evaluateHomeStructureInvariant/,
    );
  });

  void it('replaces and clears the pointer only for an active Home', () => {
    assert.match(REPLACE_HOME_PHOTO_POINTER_SQL, /photo_object_key = \$1/);
    assert.match(REPLACE_HOME_PHOTO_POINTER_SQL, /updated_at = now\(\)/);
    assert.match(REPLACE_HOME_PHOTO_POINTER_SQL, /archived_at IS NULL/);
    assert.match(CLEAR_HOME_PHOTO_POINTER_SQL, /photo_object_key = NULL/);
    assert.match(CLEAR_HOME_PHOTO_POINTER_SQL, /updated_at = now\(\)/);
  });
});

void describe('replaceHomePhotoPointer', () => {
  void it('refuses to write a temp key', async () => {
    const temp = createTempHomePhotoObjectKey(HOME_ID);
    await assert.rejects(
      () =>
        replaceHomePhotoPointer(
          {
            query: () => Promise.reject(new Error('must not write temp key')),
          },
          { homeId: HOME_ID, photoObjectKey: temp },
        ),
      AuthorizationIntegrityError,
    );
  });

  void it('refuses a canonical key for another Home', async () => {
    const other = createCanonicalHomePhotoObjectKey(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    );
    await assert.rejects(
      () =>
        replaceHomePhotoPointer(
          {
            query: () => Promise.reject(new Error('must not write cross-Home')),
          },
          { homeId: HOME_ID, photoObjectKey: other },
        ),
      AuthorizationIntegrityError,
    );
  });
});
