import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { INVITATION_ACTION } from './actions.js';
import { decideInvitationRevoke } from './revoke-policy.js';

void describe('decideInvitationRevoke', () => {
  void it('names the action-specific Admin revoke capability', () => {
    assert.equal(INVITATION_ACTION.revoke, 'invitation.revoke');
  });

  void it('allows only a transaction-current Admin', () => {
    assert.deepEqual(decideInvitationRevoke({ actorRole: 'ADMIN' }), {
      allowed: true,
    });
  });

  void it('denies Roommate invitation revocation authority', () => {
    assert.deepEqual(decideInvitationRevoke({ actorRole: 'ROOMMATE' }), {
      allowed: false,
      reason: 'INVITATION_REVOKE_DENIED',
    });
  });
});
