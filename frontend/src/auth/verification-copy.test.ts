import { describe, expect, it } from 'vitest';
import {
  VERIFY_EMAIL_BEFORE_JOINING,
  VERIFY_EMAIL_FOR_INVITATIONS,
} from './verification-copy.js';

describe('verification copy', () => {
  it('explains the global banner without implying Roomies is blocked', () => {
    expect(VERIFY_EMAIL_FOR_INVITATIONS).toMatch(/confirm your identity/i);
    expect(VERIFY_EMAIL_FOR_INVITATIONS).toMatch(/accept invitations sent to this address/i);
    expect(VERIFY_EMAIL_FOR_INVITATIONS).toMatch(/keep using Roomies in the meantime/i);
    expect(VERIFY_EMAIL_FOR_INVITATIONS).not.toMatch(
      /must verify|locked|to use roomies/i,
    );
  });

  it('explains invitation verification requires a matching verified email', () => {
    expect(VERIFY_EMAIL_BEFORE_JOINING).toMatch(
      /verified email must match this invitation/i,
    );
    expect(VERIFY_EMAIL_BEFORE_JOINING).toMatch(/verification link/i);
  });
});
