import { randomUUID } from 'node:crypto';
import {
  LOWERCASE_UUID_CAPTURE,
  assertLowercaseUuid,
  isCanonicalHomePhotoObjectKey,
  InvalidHomePhotoObjectKeyInputError,
} from './photo-object-key.js';

/**
 * Temporary unprocessed Home-photo object key:
 * tmp/homes/{homeId}/photo/{uploadId}
 *
 * Never a canonical key. Contains only Home and upload UUIDs.
 */
export const TEMP_HOME_PHOTO_OBJECT_KEY_PATTERN = new RegExp(
  `^tmp/homes/${LOWERCASE_UUID_CAPTURE}/photo/${LOWERCASE_UUID_CAPTURE}$`,
);

export function isTempHomePhotoObjectKey(
  value: string,
  homeId: string,
): boolean {
  const match = TEMP_HOME_PHOTO_OBJECT_KEY_PATTERN.exec(value);
  return match !== null && match[1] === homeId;
}

/**
 * Server-side temp key. `uploadId` is minted here with `crypto.randomUUID()`
 * (or the injected generator). Callers must not pass client-supplied keys.
 */
export function createTempHomePhotoObjectKey(
  homeId: string,
  generateId: () => string = randomUUID,
): string {
  assertLowercaseUuid(homeId);
  const uploadId = generateId();
  assertLowercaseUuid(uploadId);
  const key = `tmp/homes/${homeId}/photo/${uploadId}`;
  if (!isTempHomePhotoObjectKey(key, homeId)) {
    throw new InvalidHomePhotoObjectKeyInputError();
  }
  if (isCanonicalHomePhotoObjectKey(key, homeId)) {
    throw new InvalidHomePhotoObjectKeyInputError();
  }
  return key;
}
