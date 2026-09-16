import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UnauthenticatedError } from '../platform/auth/errors.js';
import {
  ACCOUNT_DELETION_FRESH_SESSION_MAX_AGE_MS,
  isFreshAccountDeletionSession,
  requireFreshAccountDeletionSession,
} from './account-deletion-fresh-session.js';

const NOW = new Date('2026-09-15T18:00:00.000Z');

void describe('account deletion fresh-session rule', () => {
  void it('names a 5-minute freshness constant in milliseconds', () => {
    assert.equal(ACCOUNT_DELETION_FRESH_SESSION_MAX_AGE_MS, 5 * 60 * 1000);
  });

  void it('accepts now, 4m59s, and exactly 5 minutes', () => {
    assert.equal(isFreshAccountDeletionSession(NOW, NOW), true);
    assert.equal(
      isFreshAccountDeletionSession(
        new Date(NOW.getTime() - (5 * 60 * 1000 - 1000)),
        NOW,
      ),
      true,
    );
    assert.equal(
      isFreshAccountDeletionSession(
        new Date(NOW.getTime() - ACCOUNT_DELETION_FRESH_SESSION_MAX_AGE_MS),
        NOW,
      ),
      true,
    );
  });

  void it('rejects 5 minutes + 1ms and future timestamps', () => {
    assert.equal(
      isFreshAccountDeletionSession(
        new Date(NOW.getTime() - ACCOUNT_DELETION_FRESH_SESSION_MAX_AGE_MS - 1),
        NOW,
      ),
      false,
    );
    assert.equal(
      isFreshAccountDeletionSession(new Date(NOW.getTime() + 1), NOW),
      false,
    );
  });

  void it('fails closed without exposing createdAt when stale or missing', () => {
    const clock = { now: () => NOW };
    assert.throws(
      () =>
        requireFreshAccountDeletionSession(
          new Date(
            NOW.getTime() - ACCOUNT_DELETION_FRESH_SESSION_MAX_AGE_MS - 1,
          ),
          clock,
        ),
      UnauthenticatedError,
    );
    assert.throws(
      () => requireFreshAccountDeletionSession(undefined, clock),
      UnauthenticatedError,
    );
    try {
      requireFreshAccountDeletionSession(
        new Date(NOW.getTime() + 60_000),
        clock,
      );
    } catch (error) {
      assert.ok(error instanceof UnauthenticatedError);
      assert.equal(error.message.includes('createdAt'), false);
      assert.equal(error.message.includes('60000'), false);
      assert.equal(error.message.includes('stale'), false);
    }
  });
});
