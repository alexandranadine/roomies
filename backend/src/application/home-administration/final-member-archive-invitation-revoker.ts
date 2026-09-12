import type { TransactionContext } from '../../platform/persistence/transaction.js';

export type FinalMemberArchiveInvitationInput = Readonly<{
  homeId: string;
  archivedAt: Date;
  cause: 'HOME_ARCHIVED';
}>;

/**
 * Required invitation boundary. Before invitations launch, the temporary
 * adapter must be replaced by a transactional implementation whose locks fit
 * after Task/Supply/Maintenance in the frozen global lock order.
 *
 * Future invitation acceptance/join/rejoin must lock Home first: acceptance
 * committing first makes archive observe another active Membership; archive
 * committing first makes acceptance observe an archived Home.
 */
export interface FinalMemberArchiveInvitationRevoker {
  lockPendingForHomeArchive(
    tx: TransactionContext,
    input: FinalMemberArchiveInvitationInput,
  ): Promise<void>;

  revokeLockedPendingForHomeArchive(
    tx: TransactionContext,
    input: FinalMemberArchiveInvitationInput,
  ): Promise<void>;
}
