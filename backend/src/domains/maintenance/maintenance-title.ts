import { InvalidMaintenanceTitleError } from './errors.js';

/**
 * Bounded Unicode plain-text Maintenance title. Trims surrounding whitespace,
 * rejects empty-after-trim and over-long values, and does not truncate.
 */
export const MAINTENANCE_TITLE_MAX_LENGTH = 120;

export function normalizeMaintenanceTitle(raw: string): string {
  const title = raw.trim();
  if (title.length === 0 || title.length > MAINTENANCE_TITLE_MAX_LENGTH) {
    throw new InvalidMaintenanceTitleError();
  }
  return title;
}
