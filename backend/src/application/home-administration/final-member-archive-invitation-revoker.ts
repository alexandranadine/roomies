import type { TransactionContext } from '../../platform/persistence/transaction.js';

export type FinalMemberArchiveInvitationInput = Readonly<{
  homeId: string;
  archivedAt: Date;
  cause: 'HOME_ARCHIVED';
}>;

/**
 * Invitation cleanup seam for final-member Home archive. The real adapter
 * locks effective invitation rows in ID order on the already-open Home
 * transaction, then revokes only those still pending at the archive timestamp.
 *
 * Acceptance/revoke/archive all lock Home first: acceptance committing first
 * makes archive observe another active Membership; archive committing first
 * makes acceptance observe an archived Home.
 */
export interface FinalMemberArchiveInvitationRevoker {
  lockPendingForHomeArchive(
    tx: TransactionContext,
    input: FinalMemberArchiveInvitationInput,
  ): Promise<void>;

  revokeLockedPendingForHomeArchive(
    tx: TransactionContext,
    input: FinalMemberArchiveInvitationInput,
  ): Promise<void | number>;
}
