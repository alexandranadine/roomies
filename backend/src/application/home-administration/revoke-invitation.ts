import { StructuralIntegrityError } from '../../domains/homes/structure-errors.js';
import { evaluateHomeStructureInvariant } from '../../domains/homes/structure-invariant.js';
import type { LockedHomeStructure } from '../../domains/homes/locked-home-structure.js';
import { lockHomeStructure } from '../../domains/homes/lock-home-structure.js';
import { InvitationNotAvailableError } from '../../domains/invitations/errors.js';
import { projectInvitationLifecycle } from '../../domains/invitations/invitation.js';
import type { InvitationRepository } from '../../domains/invitations/repository.js';
import { createInvitationRepository } from '../../domains/invitations/repository.js';
import { decideInvitationRevoke } from '../../domains/invitations/revoke-policy.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ForbiddenError } from '../../platform/authz/errors.js';
import {
  runInReadCommittedTransaction,
  type TransactionContext,
  type TransactionPool,
} from '../../platform/persistence/transaction.js';
import type { Clock } from '../../platform/time/clock.js';
import { systemClock } from '../../platform/time/clock.js';

export type RevokeInvitationInput = Readonly<{
  actor: ActiveHomeActor;
  homeId: string;
  invitationId: string;
}>;

export type RevokeInvitationDependencies = {
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
  invitations: Pick<InvitationRepository, 'lockById' | 'revokeLocked'>;
  clock: Clock;
};

/**
 * Home-first Admin revocation. Authorization uses the locked current role.
 * Invitation lifecycle is revalidated only after the Home structure lock.
 */
export function createRevokeInvitation(
  deps: RevokeInvitationDependencies,
): (input: RevokeInvitationInput) => Promise<void> {
  return async (input) => {
    await deps.runTransaction(async (tx) => {
      const locked = await deps.lockHomeStructure(tx, {
        homeId: input.homeId,
        actor: input.actor,
      });

      const currentInvariant = evaluateHomeStructureInvariant({
        archived: false,
        activeMemberships: locked.activeMemberships,
      });
      if (!currentInvariant.ok) {
        throw new StructuralIntegrityError();
      }

      const authorization = decideInvitationRevoke({
        actorRole: locked.actor.role,
      });
      if (!authorization.allowed) {
        throw new ForbiddenError();
      }

      const invitation = await deps.invitations.lockById(tx, {
        homeId: locked.home.id,
        invitationId: input.invitationId,
      });
      if (invitation === null) {
        throw new InvitationNotAvailableError();
      }

      const revokedAt = deps.clock.now();
      if (projectInvitationLifecycle(invitation, revokedAt) !== 'PENDING') {
        throw new InvitationNotAvailableError();
      }

      const updated = await deps.invitations.revokeLocked(tx, {
        invitationId: invitation.id,
        homeId: locked.home.id,
        revokedAt,
        cause: 'ADMIN_REVOKED',
      });
      if (updated !== 1) {
        throw new StructuralIntegrityError();
      }
    });
  };
}

export function createRevokeInvitationFromPool(
  pool: TransactionPool,
): ReturnType<typeof createRevokeInvitation> {
  return createRevokeInvitation({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeStructure,
    invitations: createInvitationRepository(
      pool as Parameters<typeof createInvitationRepository>[0],
    ),
    clock: systemClock,
  });
}
