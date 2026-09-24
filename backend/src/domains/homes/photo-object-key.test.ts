import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AuthorizationIntegrityError } from '../../platform/authz/errors.js';
import {
  CANONICAL_HOME_PHOTO_OBJECT_KEY_PATTERN,
  InvalidHomePhotoObjectKeyInputError,
  createCanonicalHomePhotoObjectKey,
  isCanonicalHomePhotoObjectKey,
  storedHomePhotoObjectKey,
} from './photo-object-key.js';
import {
  createTempHomePhotoObjectKey,
  isTempHomePhotoObjectKey,
} from './temp-photo-object-key.js';

const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GENERATION_ID = '11111111-1111-4111-8111-111111111111';
const CANONICAL = `homes/${HOME_ID}/photo/${GENERATION_ID}.webp`;

void describe('isCanonicalHomePhotoObjectKey', () => {
  void it('accepts homes/{matching-home-uuid}/photo/{generation-uuid}.webp', () => {
    assert.equal(isCanonicalHomePhotoObjectKey(CANONICAL, HOME_ID), true);
    const match = CANONICAL_HOME_PHOTO_OBJECT_KEY_PATTERN.exec(CANONICAL);
    assert.ok(match);
    assert.equal(match[1], HOME_ID);
    assert.equal(match[2], GENERATION_ID);
  });

  void it('rejects tmp prefixes, other Homes, and noncanonical forms', () => {
    const rejected = [
      `tmp/homes/${HOME_ID}/photo/${GENERATION_ID}.webp`,
      `tmp/${CANONICAL}`,
      `homes/${HOME_ID}/photo/not-a-uuid.webp`,
      `homes/not-a-uuid/photo/${GENERATION_ID}.webp`,
      `homes/${OTHER_HOME_ID}/photo/${GENERATION_ID}.webp`,
      `homes/${HOME_ID}/photo/${GENERATION_ID}.png`,
      `homes/${HOME_ID}/photo/${GENERATION_ID}.WEBP`,
      `homes/${HOME_ID}/photo/${GENERATION_ID}.webp/extra`,
      `homes/${HOME_ID}/photos/${GENERATION_ID}.webp`,
      `homes/${HOME_ID}/photo/extra/${GENERATION_ID}.webp`,
      `/${CANONICAL}`,
      `homes/${HOME_ID.toUpperCase()}/photo/${GENERATION_ID}.webp`,
      `Homes/${HOME_ID}/photo/${GENERATION_ID}.webp`,
      `homes/${HOME_ID}/Photo/${GENERATION_ID}.webp`,
      CANONICAL.toUpperCase(),
    ];
    for (const value of rejected) {
      assert.equal(isCanonicalHomePhotoObjectKey(value, HOME_ID), false, value);
    }
  });
});

void describe('storedHomePhotoObjectKey', () => {
  void it('maps NULL to null and a matching canonical key to itself', () => {
    assert.equal(storedHomePhotoObjectKey(null, HOME_ID), null);
    assert.equal(storedHomePhotoObjectKey(CANONICAL, HOME_ID), CANONICAL);
  });

  void it('fails closed on unexpected database values', () => {
    const malformed = [
      CANONICAL.toUpperCase(),
      `tmp/${CANONICAL}`,
      `homes/${OTHER_HOME_ID}/photo/${GENERATION_ID}.webp`,
      1,
      true,
      { key: CANONICAL },
      '',
    ];
    for (const value of malformed) {
      assert.throws(
        () => storedHomePhotoObjectKey(value, HOME_ID),
        AuthorizationIntegrityError,
      );
    }
  });
});

void describe('canonical Home photo key helper boundary', () => {
  void it('has no Express, pg, AWS SDK, or Sharp dependency', async () => {
    const source = await readFile(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        'photo-object-key.ts',
      ),
      'utf8',
    );
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /from ['"]@aws-sdk\//);
    assert.doesNotMatch(source, /from ['"]aws-sdk['"]/);
    assert.doesNotMatch(source, /from ['"]sharp['"]/);
  });
});

void describe('createCanonicalHomePhotoObjectKey', () => {
  void it('creates homes/{home UUID}/photo/{generation UUID}.webp', () => {
    const key = createCanonicalHomePhotoObjectKey(HOME_ID, () => GENERATION_ID);
    assert.equal(key, CANONICAL);
    assert.equal(isCanonicalHomePhotoObjectKey(key, HOME_ID), true);
  });

  void it('mints generation IDs with crypto.randomUUID()', () => {
    const key = createCanonicalHomePhotoObjectKey(HOME_ID);
    const match = CANONICAL_HOME_PHOTO_OBJECT_KEY_PATTERN.exec(key);
    assert.ok(match);
    assert.equal(match[1], HOME_ID);
    assert.match(
      match[2] ?? '',
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    assert.equal(key.includes('user'), false);
    assert.equal(key.includes('membership'), false);
    assert.equal(key.includes('@'), false);
  });

  void it('rejects non-UUID Home IDs', () => {
    assert.throws(
      () => createCanonicalHomePhotoObjectKey('not-a-uuid'),
      InvalidHomePhotoObjectKeyInputError,
    );
    assert.throws(
      () => createCanonicalHomePhotoObjectKey(HOME_ID.toUpperCase()),
      InvalidHomePhotoObjectKeyInputError,
    );
  });
});

void describe('temp vs canonical Home photo keys', () => {
  void it('rejects temp keys with the canonical validator', () => {
    const temp = createTempHomePhotoObjectKey(HOME_ID, () => GENERATION_ID);
    assert.equal(isTempHomePhotoObjectKey(temp, HOME_ID), true);
    assert.equal(isCanonicalHomePhotoObjectKey(temp, HOME_ID), false);
  });

  void it('rejects canonical keys for a different Home', () => {
    const key = createCanonicalHomePhotoObjectKey(HOME_ID, () => GENERATION_ID);
    assert.equal(isCanonicalHomePhotoObjectKey(key, OTHER_HOME_ID), false);
  });
});
