import type { CredentialMode } from './credential-form-schema.js';

/** Existing credential form on `/`, sign-in mode. */
export const SIGN_IN_HREF = '/?auth=sign-in';

/** Existing credential form on `/`, sign-up mode. */
export const SIGN_UP_HREF = '/?auth=sign-up';

/**
 * Reads the public landing CTA search param. Unknown values are ignored so
 * `/` without a recognized mode stays the closed-alpha landing.
 */
export function parseCredentialModeFromSearch(
  search: string,
): CredentialMode | null {
  const params = new URLSearchParams(
    search.startsWith('?') ? search.slice(1) : search,
  );
  const value = params.get('auth');
  if (value === 'sign-in' || value === 'sign-up') {
    return value;
  }
  return null;
}
