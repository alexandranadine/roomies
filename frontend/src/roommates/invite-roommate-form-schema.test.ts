import { describe, expect, it } from 'vitest';
import {
  inviteRoommateFormSchema,
  normalizeInvitationEmail,
} from './invite-roommate-form-schema.js';

describe('invite roommate email contract', () => {
  it('normalizes a supported email', () => {
    expect(normalizeInvitationEmail('  Jamie@Example.com ')).toBe(
      'jamie@example.com',
    );
  });

  it('rejects empty and malformed emails before submit', () => {
    expect(inviteRoommateFormSchema.safeParse({ email: '' }).success).toBe(
      false,
    );
    expect(
      inviteRoommateFormSchema.safeParse({ email: 'not-an-email' }).success,
    ).toBe(false);
    expect(
      inviteRoommateFormSchema.safeParse({ email: 'jamie@example.com' })
        .success,
    ).toBe(true);
  });
});
