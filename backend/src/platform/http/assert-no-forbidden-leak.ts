/**
 * Privacy/security test convention: assert forbidden sentinel strings do not
 * appear in response bodies, captured logs, or rendered HTML.
 *
 * Use before M5 Maintenance privacy work — keep the helper small.
 */

export type AssertNoForbiddenLeakOptions = {
  /** Human-readable context for assertion failures. */
  context: string;
  /** Haystack text to scan (response body, HTML, joined logs, etc.). */
  text: string;
  /** Strings that must never appear (secrets, raw thrown messages, etc.). */
  forbidden: readonly string[];
};

/**
 * Throws if any forbidden sentinel appears in `text` (case-sensitive substring).
 */
export function assertNoForbiddenLeak(
  options: AssertNoForbiddenLeakOptions,
): void {
  const { context, text, forbidden } = options;
  for (const needle of forbidden) {
    if (needle.length === 0) {
      continue;
    }
    if (text.includes(needle)) {
      throw new Error(
        `Forbidden leak in ${context}: sentinel ${JSON.stringify(needle)} must not appear`,
      );
    }
  }
}

/** Common substrings that should never surface in API error payloads. */
export const COMMON_SECRET_SENTINELS = [
  'postgresql://',
  'DATABASE_URL',
  'super_secret',
  'password=',
] as const;
