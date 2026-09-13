import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { InvitationPersistenceError } from './errors.js';
import { projectInvitationLifecycle } from './invitation.js';
import {
  createInvitationRepository,
  type InvitationRepository,
} from './repository.js';

export type InvitationHomeArchiveCleanupInput = Readonly<{
  homeId: string;
  archivedAt: Date;
  cause: 'HOME_ARCHIVED';
}>;

/**
 * Public invitation cleanup boundary used by final-member Home archive.
 * Persistence stays in this module. Callers must already hold the Home
 * structural lock and pass that same transaction plus the archive timestamp.
 */
export type InvitationHomeArchiveCleanup = Readonly<{
  lockPendingForHomeArchive(
    tx: TransactionContext,
    input: InvitationHomeArchiveCleanupInput,
  ): Promise<void>;

  revokeLockedPendingForHomeArchive(
    tx: TransactionContext,
    input: InvitationHomeArchiveCleanupInput,
  ): Promise<number>;
}>;

function compareInvitationId(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

export function createInvitationHomeArchiveCleanup(
  invitations: Pick<
    InvitationRepository,
    'lockEffectivePendingForHomeArchive' | 'revokeLocked'
  >,
): InvitationHomeArchiveCleanup {
  return Object.freeze({
    async lockPendingForHomeArchive(tx, input) {
      await invitations.lockEffectivePendingForHomeArchive(tx, {
        homeId: input.homeId,
        at: input.archivedAt,
      });
    },

    async revokeLockedPendingForHomeArchive(tx, input) {
      const locked = await invitations.lockEffectivePendingForHomeArchive(tx, {
        homeId: input.homeId,
        at: input.archivedAt,
      });
      const pending = [...locked]
        .filter(
          (invitation) =>
            projectInvitationLifecycle(invitation, input.archivedAt) ===
            'PENDING',
        )
        .sort((left, right) => compareInvitationId(left.id, right.id));

      let revoked = 0;
      for (const invitation of pending) {
        const updated = await invitations.revokeLocked(tx, {
          invitationId: invitation.id,
          homeId: input.homeId,
          revokedAt: input.archivedAt,
          cause: input.cause,
        });
        if (updated !== 1) {
          throw new InvitationPersistenceError();
        }
        revoked += 1;
      }
      return revoked;
    },
  });
}

export function createInvitationHomeArchiveCleanupFromPool(
  pool: Parameters<typeof createInvitationRepository>[0],
): InvitationHomeArchiveCleanup {
  return createInvitationHomeArchiveCleanup(createInvitationRepository(pool));
}
