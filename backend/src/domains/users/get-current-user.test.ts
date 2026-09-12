import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getCurrentUser } from './get-current-user.js';

void describe('getCurrentUser', () => {
  void it('returns only the canonical User id from the principal', () => {
    assert.deepEqual(getCurrentUser({ userId: 'user-1' }), { id: 'user-1' });
  });

  void it('ignores extra fields on the principal object', () => {
    const principal = {
      userId: 'user-1',
      email: 'must-not-leak@example.test',
      session: { token: 'session-token' },
    };
    assert.deepEqual(getCurrentUser(principal), { id: 'user-1' });
  });
});
