import { InvalidMaintenanceDetailsError } from './errors.js';

/**
 * Bounded Unicode plain-text Maintenance details. Nullable. Trims surrounding
 * whitespace, normalizes empty-after-trim to null, rejects over-long values,
 * and does not truncate.
 */
export const MAINTENANCE_DETAILS_MAX_LENGTH = 4000;

export function normalizeMaintenanceDetails(
  raw: string | null | undefined,
): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const details = raw.trim();
  if (details.length === 0) {
    return null;
  }
  if (details.length > MAINTENANCE_DETAILS_MAX_LENGTH) {
    throw new InvalidMaintenanceDetailsError();
  }
  return details;
}
