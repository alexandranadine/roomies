import type { ArchiveFinalMemberInput } from '../../domains/homes/archive-final-member.js';
import {
  createHomeArchiveWriter,
  type HomeArchiveWriter,
} from '../../domains/homes/archive-home.js';
import { FinalMemberRequiredError } from '../../domains/homes/errors.js';
import { createHomeArchivedV1Event } from '../../domains/homes/events.js';
import type { LockedHomeStructure } from '../../domains/homes/locked-home-structure.js';
import { lockHomeStructure } from '../../domains/homes/lock-home-structure.js';
import { decideArchiveFinalMember } from '../../domains/homes/policies.js';
import { StructuralIntegrityError } from '../../domains/homes/structure-errors.js';
import { evaluateHomeStructureInvariant } from '../../domains/homes/structure-invariant.js';
import { createMembershipEndedV1Event } from '../../domains/memberships/events.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ForbiddenError } from '../../platform/authz/errors.js';
import type { OutboxWriter } from '../../platform/events/outbox-writer.js';
import { outboxWriter } from '../../platform/events/outbox-writer.js';
import type { UuidV7Generator } from '../../platform/ids/uuid-v7.js';
import { systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import {
  runInReadCommittedTransaction,
  type TransactionContext,
  type TransactionPool,
} from '../../platform/persistence/transaction.js';
import type { Clock } from '../../platform/time/clock.js';
import { systemClock } from '../../platform/time/clock.js';
import {
  createApplyMembershipEndingWithinHomeStructureWithTemporaryNoOpCleanup,
  type ApplyMembershipEndingWithinHomeStructure,
} from './end-membership-within-home-structure.js';
import type { FinalMemberArchiveInvitationRevoker } from './final-member-archive-invitation-revoker.js';
import { createTemporaryNoOpFinalMemberArchiveInvitationRevoker } from './temporary-noop-final-member-archive-invitation-revoker.js';

export type ArchiveFinalMemberHomeDependencies = {
  runTransaction: <T>(
    work: (tx: TransactionContext) => Promise<T>,
  ) => Promise<T>;
  lockHomeStructure: (
    tx: TransactionContext,
    input: {
      homeId: string;
      actor: Pick<
        ActiveHomeActor,
        'userId' | 'membershipId' | 'homeId' | 'role'
      >;
    },
  ) => Promise<LockedHomeStructure>;
  clock: Clock;
  invitationRevoker: FinalMemberArchiveInvitationRevoker;
  applyMembershipEnding: ApplyMembershipEndingWithinHomeStructure;
  homeArchive: HomeArchiveWriter;
  outbox: Pick<OutboxWriter, 'append'>;
  ids: UuidV7Generator;
};

export function createArchiveFinalMemberHome(
  deps: ArchiveFinalMemberHomeDependencies,
): (input: ArchiveFinalMemberInput) => Promise<void> {
  return async (input) => {
    const archivedAt = deps.clock.now();

    await deps.runTransaction(async (tx) => {
      const locked = await deps.lockHomeStructure(tx, input);

      const invariant = evaluateHomeStructureInvariant({
        archived: false,
        activeMemberships: locked.activeMemberships,
      });
      if (!invariant.ok) {
        throw new StructuralIntegrityError();
      }

      const decision = decideArchiveFinalMember(locked);
      if (!decision.allowed) {
        if (decision.reason === 'ACTOR_NOT_ADMIN') {
          throw new ForbiddenError();
        }
        if (decision.reason === 'FINAL_MEMBER_REQUIRED') {
          throw new FinalMemberRequiredError();
        }
        throw new StructuralIntegrityError();
      }

      const invitationInput = Object.freeze({
        homeId: locked.home.id,
        archivedAt,
        cause: 'HOME_ARCHIVED' as const,
      });
      await deps.invitationRevoker.lockPendingForHomeArchive(
        tx,
        invitationInput,
      );
      await deps.invitationRevoker.revokeLockedPendingForHomeArchive(
        tx,
        invitationInput,
      );

      await deps.applyMembershipEnding(tx, {
        homeId: locked.home.id,
        membershipId: locked.actor.membershipId,
        endedAt: archivedAt,
        cause: 'HOME_ARCHIVED',
      });

      const archived = await deps.homeArchive.archiveActiveHome(tx, {
        homeId: locked.home.id,
        archivedAt,
      });
      if (archived !== 1) {
        throw new StructuralIntegrityError();
      }

      await deps.outbox.append(
        tx,
        createMembershipEndedV1Event({
          eventId: deps.ids.next(),
          occurredAt: archivedAt,
          membershipId: locked.actor.membershipId,
          cause: 'HOME_ARCHIVED',
          homeId: locked.home.id,
        }),
      );
      await deps.outbox.append(
        tx,
        createHomeArchivedV1Event({
          eventId: deps.ids.next(),
          occurredAt: archivedAt,
          homeId: locked.home.id,
        }),
      );
    });
  };
}

export function createArchiveFinalMemberHomeFromPool(
  pool: TransactionPool,
): ReturnType<typeof createArchiveFinalMemberHome> {
  return createArchiveFinalMemberHome({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeStructure,
    clock: systemClock,
    invitationRevoker: createTemporaryNoOpFinalMemberArchiveInvitationRevoker(),
    applyMembershipEnding:
      createApplyMembershipEndingWithinHomeStructureWithTemporaryNoOpCleanup(),
    homeArchive: createHomeArchiveWriter(),
    outbox: outboxWriter,
    ids: systemUuidV7,
  });
}
