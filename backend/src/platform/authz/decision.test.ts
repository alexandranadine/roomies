import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allow, deny } from './decision.js';

void describe('AuthorizationDecision primitives', () => {
  void it('allow returns a reason-free permitted decision', () => {
    assert.deepEqual(allow(), { allowed: true });
    assert.ok(!('reason' in allow()));
  });

  void it('deny keeps the backend-only reason', () => {
    assert.deepEqual(deny('HOME_SCOPE_MISMATCH'), {
      allowed: false,
      reason: 'HOME_SCOPE_MISMATCH',
    });
  });
});
