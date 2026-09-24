import { AuthorizationIntegrityError } from '../../platform/authz/errors.js';

/**
 * Canonical processed Home-photo object key:
 * homes/{homeId}/photo/{generationId}.webp
 *
 * Lowercase hex UUIDs only. This is the application source of truth; the
 * database CHECK is defense-in-depth, not a substitute for this helper.
 */
export const CANONICAL_HOME_PHOTO_OBJECT_KEY_PATTERN =
  /^homes\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/photo\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.webp$/;

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
