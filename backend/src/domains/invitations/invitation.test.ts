import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { projectInvitationLifecycle } from './invitation.js';

const expiresAt = new Date('2026-10-08T00:00:00.000Z');

void describe('projectInvitationLifecycle', () => {
  void it('derives pending and expiration solely from expiresAt', () => {
    const open = { acceptedAt: null, revokedAt: null, expiresAt };
    assert.equal(
      projectInvitationLifecycle(open, new Date('2026-10-07T23:59:59.999Z')),
      'PENDING',
    );
    assert.equal(projectInvitationLifecycle(open, expiresAt), 'EXPIRED');
  });

  void it('projects accepted and revoked terminal states', () => {
    assert.equal(
      projectInvitationLifecycle(
        {
          acceptedAt: new Date('2026-10-07T00:00:00.000Z'),
          revokedAt: null,
          expiresAt,
        },
        expiresAt,
      ),
      'ACCEPTED',
    );
    assert.equal(
      projectInvitationLifecycle(
        {
          acceptedAt: null,
          revokedAt: new Date('2026-10-07T00:00:00.000Z'),
          expiresAt,
        },
        expiresAt,
      ),
      'REVOKED',
    );
  });
});
