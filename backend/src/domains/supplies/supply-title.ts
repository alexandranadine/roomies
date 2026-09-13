import { InvalidSupplyTitleError } from './errors.js';

/**
 * Bounded plain-text Supply title. Task titles are unbounded TEXT; Supply
 * uses a product bound instead. Trims surrounding whitespace, rejects
 * empty-after-trim and over-long values, and does not truncate or slug.
 */
export const SUPPLY_TITLE_MAX_LENGTH = 120;

export function normalizeSupplyTitle(raw: string): string {
  const title = raw.trim();
  if (title.length === 0 || title.length > SUPPLY_TITLE_MAX_LENGTH) {
    throw new InvalidSupplyTitleError();
  }
  return title;
}
