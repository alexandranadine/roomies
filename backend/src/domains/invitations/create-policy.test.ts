import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decideInvitationCreate } from './create-policy.js';

void describe('decideInvitationCreate', () => {
  void it('allows only a transaction-current Admin', () => {
    assert.deepEqual(decideInvitationCreate({ actorRole: 'ADMIN' }), {
      allowed: true,
    });
  });

  void it('denies Roommate invitation authority', () => {
    assert.deepEqual(decideInvitationCreate({ actorRole: 'ROOMMATE' }), {
      allowed: false,
      reason: 'INVITATION_CREATE_DENIED',
    });
  });
});
