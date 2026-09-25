import { describe, expect, it } from 'vitest';
import { formatInvitationExpiration } from './invite-format.js';

describe('formatInvitationExpiration', () => {
  it('formats a valid ISO timestamp', () => {
    expect(formatInvitationExpiration('2026-10-01T12:00:00.000Z')).toMatch(
      /2026/,
    );
  });

  it('returns the original string when the timestamp is invalid', () => {
    expect(formatInvitationExpiration('not-a-date')).toBe('not-a-date');
  });
});
