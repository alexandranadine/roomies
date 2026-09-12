import { StructuralIntegrityError } from '../../domains/homes/structure-errors.js';
import { evaluateHomeStructureInvariant } from '../../domains/homes/structure-invariant.js';
import type { LockedHomeStructure } from '../../domains/homes/locked-home-structure.js';
import { lockHomeStructure } from '../../domains/homes/lock-home-structure.js';
import { LastAdminRequiredError } from '../../domains/memberships/errors.js';
import type { RemoveMembershipInput } from '../../domains/memberships/remove.js';
import {
  decideMembershipRemove,
  decideMembershipRemoveProposed,
  decideMembershipRemoveSelf,
  decideMembershipRemoveTarget,
} from '../../domains/memberships/remove-policy.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  ForbiddenError,
} from '../../platform/authz/errors.js';
import {
  runInReadCommittedTransaction,
  type TransactionContext,
  type TransactionPool,
} from '../../platform/persistence/transaction.js';
import type { Clock } from '../../platform/time/clock.js';
import { systemClock } from '../../platform/time/clock.js';
import type { EndMembershipWithinHomeStructure } from './end-membership-within-home-structure.js';
import { createEndMembershipWithinHomeStructureWithTemporaryNoOpCleanup } from './end-membership-within-home-structure.js';

export type RemoveMembershipDependencies = {
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
  endMembership: EndMembershipWithinHomeStructure;
};

export function createRemoveMembership(
  deps: RemoveMembershipDependencies,
): (input: RemoveMembershipInput) => Promise<void> {
  return async (input) => {
    const endedAt = deps.clock.now();

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

      const capability = decideMembershipRemove({
        actorRole: locked.actor.role,
      });
      if (!capability.allowed) {
        throw new ForbiddenError();
      }

      const targetDecision = decideMembershipRemoveTarget({
        pathMembershipId: input.membershipId,
        lockedActiveMembershipIds: locked.activeMemberships.map(
          (membership) => membership.id,
        ),
      });
      if (!targetDecision.allowed) {
        throw new ConcealedNotFoundError();
      }

      const target = locked.activeMemberships.find(
        (membership) =>
          membership.id === input.membershipId &&
          membership.homeId === locked.home.id,
      );
      if (target === undefined) {
        throw new ConcealedNotFoundError();
      }

      const self = decideMembershipRemoveSelf({
        actorMembershipId: locked.actor.membershipId,
        pathMembershipId: target.id,
      });
      if (!self.allowed) {
        throw new ForbiddenError();
      }

      const proposed = decideMembershipRemoveProposed({
        targetMembershipId: target.id,
        activeMemberships: locked.activeMemberships,
      });
      if (!proposed.allowed) {
        throw new LastAdminRequiredError();
      }

      await deps.endMembership(tx, {
        homeId: locked.home.id,
        membershipId: target.id,
        endedAt,
        cause: 'ADMIN_REMOVAL',
      });
    });
  };
}

export function createRemoveMembershipFromPool(
  pool: TransactionPool,
): ReturnType<typeof createRemoveMembership> {
  return createRemoveMembership({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeStructure,
    clock: systemClock,
    endMembership:
      createEndMembershipWithinHomeStructureWithTemporaryNoOpCleanup(),
  });
}
