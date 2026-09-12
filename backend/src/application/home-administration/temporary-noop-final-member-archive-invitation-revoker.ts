import type { FinalMemberArchiveInvitationRevoker } from './final-member-archive-invitation-revoker.js';

/**
 * Temporary adapter while invitations have no persistence. It intentionally
 * performs no SQL, I/O, event append, or connection acquisition and MUST be
 * replaced before invitations ship.
 */
export function createTemporaryNoOpFinalMemberArchiveInvitationRevoker(): FinalMemberArchiveInvitationRevoker {
  return Object.freeze({
    lockPendingForHomeArchive: () => Promise.resolve(),
    revokeLockedPendingForHomeArchive: () => Promise.resolve(),
  });
}
