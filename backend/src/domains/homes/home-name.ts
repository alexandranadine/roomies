export const HOME_NAME_MAX_LENGTH = 80;

export class InvalidHomeNameError extends Error {
  override readonly name = 'InvalidHomeNameError';

  constructor() {
    super('Invalid Home name');
  }
}

/**
 * Bounded plain-text Home name. Trims surrounding whitespace only, rejects
 * empty-after-trim and over-long values, and does not truncate or filter.
 */
export function normalizeHomeName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0 || name.length > HOME_NAME_MAX_LENGTH) {
    throw new InvalidHomeNameError();
  }
  return name;
}
