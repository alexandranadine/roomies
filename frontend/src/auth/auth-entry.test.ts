import { describe, expect, it } from 'vitest';
import { parseCredentialModeFromSearch } from './auth-entry.js';

describe('parseCredentialModeFromSearch', () => {
  it('reads sign-in and sign-up from the auth search param', () => {
    expect(parseCredentialModeFromSearch('?auth=sign-in')).toBe('sign-in');
    expect(parseCredentialModeFromSearch('auth=sign-up')).toBe('sign-up');
  });

  it('ignores missing or unknown values so `/` can stay the landing', () => {
    expect(parseCredentialModeFromSearch('')).toBeNull();
    expect(parseCredentialModeFromSearch('?auth=register')).toBeNull();
    expect(parseCredentialModeFromSearch('?other=sign-in')).toBeNull();
  });
});
