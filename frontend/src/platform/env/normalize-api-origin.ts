/**
 * Normalize and validate a public origin URL (`scheme://host[:port]`).
 *
 * Accepts absolute http(s) URLs with no credentials, query, hash, or path
 * (non-root paths are rejected). Returns the canonical `url.origin`.
 */
export function normalizePublicOrigin(raw: string, label: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (trimmed.includes('*')) {
    throw new Error(`wildcard ${label} values are not allowed`);
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`malformed ${label} URL`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must use http or https`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`${label} must not include credentials`);
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error(`${label} must not include query or hash`);
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(`${label} must not include a path`);
  }
  if (url.hostname.includes('*')) {
    throw new Error(`wildcard hosts are not allowed`);
  }

  return url.origin;
}

/**
 * Normalize and validate an API origin URL.
 *
 * Accepts absolute http(s) URLs with no credentials, query, hash, or path
 * (non-root paths are rejected). Returns the canonical `url.origin`.
 */
export function normalizeApiOrigin(raw: string): string {
  return normalizePublicOrigin(raw, 'API origin');
}
