import { randomUUID } from 'node:crypto';
import { AuthorizationIntegrityError } from '../../platform/authz/errors.js';

/** Lowercase hex UUID used in Home-photo object keys. */
export const LOWERCASE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const LOWERCASE_UUID_CAPTURE =
  '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

/**
 * Thrown when Home-photo key generation receives a non-canonical UUID.
 * Not an HTTP error.
 */
export class InvalidHomePhotoObjectKeyInputError extends Error {
  override readonly name = 'InvalidHomePhotoObjectKeyInputError';

  constructor() {
    super('Invalid Home photo object key input');
  }
}

export function assertLowercaseUuid(value: string): void {
  if (!LOWERCASE_UUID_PATTERN.test(value)) {
    throw new InvalidHomePhotoObjectKeyInputError();
  }
}

/**
 * Canonical processed Home-photo object key:
 * homes/{homeId}/photo/{generationId}.webp
 *
 * Lowercase hex UUIDs only. This is the application source of truth; the
 * database CHECK is defense-in-depth, not a substitute for this helper.
 */
export const CANONICAL_HOME_PHOTO_OBJECT_KEY_PATTERN = new RegExp(
  `^homes/${LOWERCASE_UUID_CAPTURE}/photo/${LOWERCASE_UUID_CAPTURE}\\.webp$`,
);

/**
 * True only when `value` is the canonical key for `homeId`. Rejects tmp
 * prefixes, other Homes, malformed UUIDs, wrong extensions, extra path
 * components, and uppercase/noncanonical forms.
 */
export function isCanonicalHomePhotoObjectKey(
  value: string,
  homeId: string,
): boolean {
  const match = CANONICAL_HOME_PHOTO_OBJECT_KEY_PATTERN.exec(value);
  return match !== null && match[1] === homeId;
}

/**
 * Server-side canonical key. `generationId` is always minted here with
 * `crypto.randomUUID()` (or the injected generator). Callers must not pass
 * client-supplied object keys.
 */
export function createCanonicalHomePhotoObjectKey(
  homeId: string,
  generateId: () => string = randomUUID,
): string {
  assertLowercaseUuid(homeId);
  const generationId = generateId();
  assertLowercaseUuid(generationId);
  const key = `homes/${homeId}/photo/${generationId}.webp`;
  if (!isCanonicalHomePhotoObjectKey(key, homeId)) {
    throw new InvalidHomePhotoObjectKeyInputError();
  }
  return key;
}

/**
 * Map a persisted `photo_object_key` onto the Home domain field.
 * NULL stays null. Any other unexpected database value fails closed.
 */
export function storedHomePhotoObjectKey(
  value: unknown,
  homeId: string,
): string | null {
  if (value === null) {
    return null;
  }
  if (
    typeof value === 'string' &&
    isCanonicalHomePhotoObjectKey(value, homeId)
  ) {
    return value;
  }
  throw new AuthorizationIntegrityError();
}
