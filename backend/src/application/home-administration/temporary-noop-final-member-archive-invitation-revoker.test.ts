import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import type { FinalMemberArchiveInvitationRevoker } from './final-member-archive-invitation-revoker.js';
import { createTemporaryNoOpFinalMemberArchiveInvitationRevoker } from './temporary-noop-final-member-archive-invitation-revoker.js';

void describe('temporary final-member archive invitation revoker', () => {
  void it('satisfies the required port without SQL or other observable effects', async () => {
    let queryCalls = 0;
    const tx: TransactionContext = {
      query: () => {
        queryCalls += 1;
        return Promise.reject(new Error('no-op must not query'));
      },
    };
    const input = {
      homeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      archivedAt: new Date('2026-09-12T20:00:00.000Z'),
      cause: 'HOME_ARCHIVED' as const,
    };
    const revoker: FinalMemberArchiveInvitationRevoker =
      createTemporaryNoOpFinalMemberArchiveInvitationRevoker();

    await revoker.lockPendingForHomeArchive(tx, input);
    await revoker.revokeLockedPendingForHomeArchive(tx, input);

    assert.equal(queryCalls, 0);
  });

  void it('is explicitly temporary and must be replaced before invitations ship', () => {
    assert.match(
      createTemporaryNoOpFinalMemberArchiveInvitationRevoker.toString(),
      /TemporaryNoOp/,
    );
  });
});
