import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeEmail } from '../../platform/auth/index.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { InvitationPersistenceError } from './errors.js';
import { createInvitationHomeArchiveCleanup } from './home-archive-cleanup.js';
import type { Invitation } from './invitation.js';
import { LOCK_EFFECTIVE_PENDING_INVITATIONS_FOR_HOME_ARCHIVE_SQL } from './repository.js';
import { invitationTokenHash } from './token-hash.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBERSHIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ARCHIVED_AT = new Date('2026-10-04T12:00:00.000Z');
const CREATED_AT = new Date('2026-10-01T00:00:00.000Z');
const EXPIRES_AT = new Date('2026-10-08T00:00:00.000Z');

const tx: TransactionContext = {
  query: () =>
    Promise.reject(new Error('cleanup must use the invitation port')),
};

function invitation(
  overrides: Partial<Invitation> & Pick<Invitation, 'id'>,
): Invitation {
  return Object.freeze({
    homeId: HOME,
    invitedEmail: normalizeEmail(`${overrides.id}@example.com`),
    tokenHash: invitationTokenHash(new Uint8Array(32).fill(7)),
    createdByMembershipId: MEMBERSHIP,
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    acceptedAt: null,
    acceptedMembershipId: null,
    revokedAt: null,
    revocationCause: null,
    ...overrides,
  });
}

void describe('invitation home-archive cleanup', () => {
  void it('locks in ID order and revokes only pending rows at the archive timestamp', async () => {
    const later = invitation({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    });
    const earlier = invitation({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01',
    });
    const expired = invitation({
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      expiresAt: ARCHIVED_AT,
    });
    const calls: string[] = [];
    const revoked: unknown[] = [];
    const cleanup = createInvitationHomeArchiveCleanup({
      lockEffectivePendingForHomeArchive(_tx, input) {
        calls.push('lock');
        assert.equal(_tx, tx);
        assert.deepEqual(input, { homeId: HOME, at: ARCHIVED_AT });
        return Promise.resolve([later, earlier, expired]);
      },
      revokeLocked(_tx, input) {
        calls.push(`revoke:${input.invitationId}`);
        assert.equal(_tx, tx);
        revoked.push(input);
        return Promise.resolve(1);
      },
    });

    const input = {
      homeId: HOME,
      archivedAt: ARCHIVED_AT,
      cause: 'HOME_ARCHIVED' as const,
    };
    await cleanup.lockPendingForHomeArchive(tx, input);
    const count = await cleanup.revokeLockedPendingForHomeArchive(tx, input);

    assert.equal(count, 2);
    assert.deepEqual(calls, [
      'lock',
      'lock',
      `revoke:${earlier.id}`,
      `revoke:${later.id}`,
    ]);
    assert.deepEqual(revoked, [
      {
        invitationId: earlier.id,
        homeId: HOME,
        revokedAt: ARCHIVED_AT,
        cause: 'HOME_ARCHIVED',
      },
      {
        invitationId: later.id,
        homeId: HOME,
        revokedAt: ARCHIVED_AT,
        cause: 'HOME_ARCHIVED',
      },
    ]);
  });

  void it('does not rewrite accepted, Admin-revoked, or expired invitations', async () => {
    const accepted = invitation({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa11',
      acceptedAt: new Date('2026-10-02T00:00:00.000Z'),
      acceptedMembershipId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    });
    const adminRevoked = invitation({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa12',
      revokedAt: new Date('2026-10-03T00:00:00.000Z'),
      revocationCause: 'ADMIN_REVOKED',
    });
    const expired = invitation({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa13',
      expiresAt: new Date('2026-10-04T00:00:00.000Z'),
    });
    const cleanup = createInvitationHomeArchiveCleanup({
      lockEffectivePendingForHomeArchive() {
        return Promise.resolve([accepted, adminRevoked, expired]);
      },
      revokeLocked() {
        return Promise.reject(new Error('must not revoke terminal or expired'));
      },
    });

    const count = await cleanup.revokeLockedPendingForHomeArchive(tx, {
      homeId: HOME,
      archivedAt: ARCHIVED_AT,
      cause: 'HOME_ARCHIVED',
    });
    assert.equal(count, 0);
  });

  void it('scopes lock and revoke to the archived Home', async () => {
    const cleanup = createInvitationHomeArchiveCleanup({
      lockEffectivePendingForHomeArchive(_tx, input) {
        assert.equal(input.homeId, HOME);
        assert.notEqual(input.homeId, OTHER_HOME);
        return Promise.resolve([]);
      },
      revokeLocked() {
        return Promise.reject(new Error('no other Home rows to revoke'));
      },
    });
    const input = {
      homeId: HOME,
      archivedAt: ARCHIVED_AT,
      cause: 'HOME_ARCHIVED' as const,
    };
    await cleanup.lockPendingForHomeArchive(tx, input);
    assert.equal(await cleanup.revokeLockedPendingForHomeArchive(tx, input), 0);
  });

  void it('fails closed when a revalidated pending row cannot be revoked', async () => {
    const pending = invitation({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa21',
    });
    const cleanup = createInvitationHomeArchiveCleanup({
      lockEffectivePendingForHomeArchive() {
        return Promise.resolve([pending]);
      },
      revokeLocked() {
        return Promise.resolve(0);
      },
    });
    await assert.rejects(
      () =>
        cleanup.revokeLockedPendingForHomeArchive(tx, {
          homeId: HOME,
          archivedAt: ARCHIVED_AT,
          cause: 'HOME_ARCHIVED',
        }),
      InvitationPersistenceError,
    );
  });

  void it('uses the caller timestamp and never reads Date.now', async () => {
    const originalNow = Date.now;
    let nowCalls = 0;
    Date.now = () => {
      nowCalls += 1;
      return originalNow();
    };
    try {
      const pending = invitation({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa31',
      });
      const cleanup = createInvitationHomeArchiveCleanup({
        lockEffectivePendingForHomeArchive(_tx, input) {
          assert.equal(input.at, ARCHIVED_AT);
          return Promise.resolve([pending]);
        },
        revokeLocked(_tx, input) {
          assert.equal(input.revokedAt, ARCHIVED_AT);
          return Promise.resolve(1);
        },
      });
      await cleanup.revokeLockedPendingForHomeArchive(tx, {
        homeId: HOME,
        archivedAt: ARCHIVED_AT,
        cause: 'HOME_ARCHIVED',
      });
      assert.equal(nowCalls, 0);
    } finally {
      Date.now = originalNow;
    }
  });

  void it('locks effective pending invitation rows by invitation ID', () => {
    assert.match(
      LOCK_EFFECTIVE_PENDING_INVITATIONS_FOR_HOME_ARCHIVE_SQL,
      /expires_at > \$2/,
    );
    assert.match(
      LOCK_EFFECTIVE_PENDING_INVITATIONS_FOR_HOME_ARCHIVE_SQL,
      /ORDER BY id/,
    );
    assert.doesNotMatch(
      LOCK_EFFECTIVE_PENDING_INVITATIONS_FOR_HOME_ARCHIVE_SQL,
      /Date\.now/,
    );
  });
});
