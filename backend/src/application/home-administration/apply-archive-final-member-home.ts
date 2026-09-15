import {
  createHomeArchiveWriter,
  type HomeArchiveWriter,
} from '../../domains/homes/archive-home.js';
import { createHomeArchivedV1Event } from '../../domains/homes/events.js';
import { StructuralIntegrityError } from '../../domains/homes/structure-errors.js';
import { createInvitationHomeArchiveCleanupFromPool } from '../../domains/invitations/home-archive-cleanup.js';
import { createMembershipEndedV1Event } from '../../domains/memberships/events.js';
import type { OutboxWriter } from '../../platform/events/outbox-writer.js';
import { outboxWriter } from '../../platform/events/outbox-writer.js';
import type { UuidV7Generator } from '../../platform/ids/uuid-v7.js';
import { systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import type {
  TransactionContext,
  TransactionPool,
} from '../../platform/persistence/transaction.js';
import {
  createApplyMembershipEndingWithinHomeStructureFromPool,
  type ApplyMembershipEndingWithinHomeStructure,
} from './end-membership-within-home-structure.js';
import type { FinalMemberArchiveInvitationRevoker } from './final-member-archive-invitation-revoker.js';

/**
 * Caller-owned final-member archive mutation. The caller already locked Home
 * then active Memberships, completed policy, and supplied the operation
 * timestamp. Does not begin, commit, or lock.
 */
export type ApplyArchiveFinalMemberHomeInput = Readonly<{
  homeId: string;
  membershipId: string;
  archivedAt: Date;
}>;

export type ApplyArchiveFinalMemberHome = (
  tx: TransactionContext,
  input: ApplyArchiveFinalMemberHomeInput,
) => Promise<void>;

export type ApplyArchiveFinalMemberHomeDependencies = {
  invitationRevoker: FinalMemberArchiveInvitationRevoker;
  applyMembershipEnding: ApplyMembershipEndingWithinHomeStructure;
  homeArchive: HomeArchiveWriter;
  outbox: Pick<OutboxWriter, 'append'>;
  ids: UuidV7Generator;
};

/**
 * Frozen archive consequences inside an already-open structural transaction:
 * pending invitation revoke → Task/Supply/Notification cleanup + Membership
 * end → Home archived_at → membership.ended.v1 → home.archived.v1.
 */
export function createApplyArchiveFinalMemberHome(
  deps: ApplyArchiveFinalMemberHomeDependencies,
): ApplyArchiveFinalMemberHome {
  return async (tx, input) => {
    const invitationInput = Object.freeze({
      homeId: input.homeId,
      archivedAt: input.archivedAt,
      cause: 'HOME_ARCHIVED' as const,
    });
    await deps.invitationRevoker.lockPendingForHomeArchive(tx, invitationInput);
    await deps.invitationRevoker.revokeLockedPendingForHomeArchive(
      tx,
      invitationInput,
    );

    await deps.applyMembershipEnding(tx, {
      homeId: input.homeId,
      membershipId: input.membershipId,
      endedAt: input.archivedAt,
      endedByMembershipId: input.membershipId,
      cause: 'HOME_ARCHIVED',
    });

    const archived = await deps.homeArchive.archiveActiveHome(tx, {
      homeId: input.homeId,
      archivedAt: input.archivedAt,
    });
    if (archived !== 1) {
      throw new StructuralIntegrityError();
    }

    await deps.outbox.append(
      tx,
      createMembershipEndedV1Event({
        eventId: deps.ids.next(),
        occurredAt: input.archivedAt,
        membershipId: input.membershipId,
        homeId: input.homeId,
      }),
    );
    await deps.outbox.append(
      tx,
      createHomeArchivedV1Event({
        eventId: deps.ids.next(),
        occurredAt: input.archivedAt,
        homeId: input.homeId,
      }),
    );
  };
}

export function createApplyArchiveFinalMemberHomeFromPool(
  pool: TransactionPool,
): ApplyArchiveFinalMemberHome {
  return createApplyArchiveFinalMemberHome({
    invitationRevoker: createInvitationHomeArchiveCleanupFromPool(
      pool as Parameters<typeof createInvitationHomeArchiveCleanupFromPool>[0],
    ),
    applyMembershipEnding:
      createApplyMembershipEndingWithinHomeStructureFromPool(pool),
    homeArchive: createHomeArchiveWriter(),
    outbox: outboxWriter,
    ids: systemUuidV7,
  });
}
