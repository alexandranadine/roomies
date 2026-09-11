/**
 * Normalize and validate an exact trusted origin URL.
 *
 * Accepts only absolute http(s) URLs with no wildcard host, credentials,
 * query, or hash. Non-root paths are rejected so misconfigured app URLs
 * fail at startup rather than being silently truncated.
 *
 * Returns the canonical `url.origin` (scheme://host[:port]).
 */
export function normalizeTrustedOrigin(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error('origin must not be empty');
  }
  if (trimmed.includes('*')) {
    throw new Error('wildcard origins are not allowed');
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('malformed URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('origin must use http or https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('origin must not include credentials');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('origin must not include query or hash');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('origin must not include a path');
  }
  if (url.hostname.includes('*')) {
    throw new Error('wildcard hosts are not allowed');
  }

  return url.origin;
}

/**
 * Parse a comma-separated TRUSTED_ORIGINS value into normalized origins.
 * Deduplicates while preserving first-seen order.
 */
export function parseTrustedOriginsList(raw: string): string[] {
  const parts = raw.split(',');
  const origins: string[] = [];
  const seen = new Set<string>();

  for (const part of parts) {
    if (part.trim().length === 0) {
      // Allow trailing/leading commas and whitespace-only segments to be skipped
      // only when the whole string isn't just empties — empty list handled by caller.
      continue;
    }
    const origin = normalizeTrustedOrigin(part);
    if (!seen.has(origin)) {
      seen.add(origin);
      origins.push(origin);
    }
  }

  if (origins.length === 0) {
    throw new Error('TRUSTED_ORIGINS must list at least one origin');
  }

  return origins;
}
