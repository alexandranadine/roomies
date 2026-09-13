import { StructuralIntegrityError } from '../../domains/homes/structure-errors.js';
import { evaluateHomeStructureInvariant } from '../../domains/homes/structure-invariant.js';
import type { LockedHomeStructure } from '../../domains/homes/locked-home-structure.js';
import { lockHomeStructure } from '../../domains/homes/lock-home-structure.js';
import {
  LastAdminRequiredError,
  LastRoommateRequiresArchiveError,
} from '../../domains/memberships/errors.js';
import type { LeaveMembershipInput } from '../../domains/memberships/leave.js';
import {
  decideMembershipLeave,
  decideMembershipLeaveSelf,
} from '../../domains/memberships/leave-policy.js';
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
import {
  createEndMembershipWithinHomeStructureFromPool,
  type EndMembershipWithinHomeStructure,
} from './end-membership-within-home-structure.js';

export type LeaveMembershipDependencies = {
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

export function createLeaveMembership(
  deps: LeaveMembershipDependencies,
): (input: LeaveMembershipInput) => Promise<void> {
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

      const self = decideMembershipLeaveSelf({
        actorMembershipId: locked.actor.membershipId,
        pathMembershipId: input.membershipId,
        lockedActiveMembershipIds: locked.activeMemberships.map(
          (membership) => membership.id,
        ),
      });
      if (!self.allowed) {
        if (self.reason === 'MEMBERSHIP_LEAVE_TARGET_CONCEALED') {
          throw new ConcealedNotFoundError();
        }
        throw new ForbiddenError();
      }

      const policy = decideMembershipLeave({
        actorMembershipId: locked.actor.membershipId,
        activeMemberships: locked.activeMemberships,
      });
      if (!policy.allowed) {
        if (policy.reason === 'LAST_ROOMMATE_REQUIRES_ARCHIVE') {
          throw new LastRoommateRequiresArchiveError();
        }
        throw new LastAdminRequiredError();
      }

      const endedAt = deps.clock.now();

      await deps.endMembership(tx, {
        homeId: locked.home.id,
        membershipId: locked.actor.membershipId,
        endedAt,
        cause: 'VOLUNTARY_LEAVE',
      });
    });
  };
}

export function createLeaveMembershipFromPool(
  pool: TransactionPool,
): ReturnType<typeof createLeaveMembership> {
  return createLeaveMembership({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeStructure,
    clock: systemClock,
    endMembership: createEndMembershipWithinHomeStructureFromPool(pool),
  });
}
