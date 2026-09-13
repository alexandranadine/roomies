import {
  lockHomeAndExactMemberships,
  type LockedHomeAndExactMemberships,
} from '../../domains/homes/lock-home-and-exact-memberships.js';
import {
  SupplyClaimNotActiveError,
  SupplyPersistenceError,
} from '../../domains/supplies/errors.js';
import { decideSupplyReleaseClaim } from '../../domains/supplies/release-policy.js';
import {
  createSupplyRepository,
  type ReleaseActiveClaimOwnedByMembership,
  type SupplyRepository,
} from '../../domains/supplies/repository.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import {
  runInReadCommittedTransaction,
  type TransactionContext,
  type TransactionPool,
} from '../../platform/persistence/transaction.js';
import type { Clock } from '../../platform/time/clock.js';
import { systemClock } from '../../platform/time/clock.js';
import type { LockHomeAndExactMemberships } from './create-supply-entry.js';

export type ReleaseSupplyClaimInput = Readonly<{
  actor: ActiveHomeActor;
  homeId: string;
  supplyEntryId: string;
}>;

export type ReleaseSupplyClaimDependencies = Readonly<{
  runTransaction: <T>(
    work: (tx: TransactionContext) => Promise<T>,
  ) => Promise<T>;
  lockHomeAndExactMemberships: LockHomeAndExactMemberships;
  supplies: Pick<
    SupplyRepository,
    | 'lockSupplyEntryByHomeAndId'
    | 'lockActiveClaimByEntry'
    | 'releaseActiveClaimOwnedByMembership'
  >;
  clock: Clock;
}>;

function revalidatedActor(
  locked: LockedHomeAndExactMemberships,
  input: ReleaseSupplyClaimInput,
): ActiveHomeActor {
  if (locked.home.id !== input.homeId || locked.home.archivedAt !== null) {
    throw new ConcealedNotFoundError();
  }

  const actorRow = locked.memberships.find(
    (membership) => membership.id === input.actor.membershipId,
  );
  if (
    actorRow === undefined ||
    actorRow.endedAt !== null ||
    actorRow.userId !== input.actor.userId ||
    actorRow.homeId !== input.homeId ||
    actorRow.homeId !== input.actor.homeId ||
    actorRow.id !== input.actor.membershipId
  ) {
    throw new ConcealedNotFoundError();
  }

  return Object.freeze({
    userId: actorRow.userId,
    membershipId: actorRow.id,
    homeId: actorRow.homeId,
    role: actorRow.role,
  });
}

/**
 * Manually releases the actor's own active SupplyClaim.
 *
 * Mutation order inside READ COMMITTED:
 * Home FOR UPDATE → exact actor Membership FOR UPDATE → revalidate Home →
 * revalidate exact actor tenure/user/home/current DB role → SupplyEntry
 * FOR UPDATE → active SupplyClaim FOR UPDATE → authorize
 * supply.release_claim → one Clock.now() → conditional CLAIMANT_RELEASED
 * update.
 */
export function createReleaseSupplyClaim(
  deps: ReleaseSupplyClaimDependencies,
): (input: ReleaseSupplyClaimInput) => Promise<void> {
  return async (input) => {
    if (input.actor.homeId !== input.homeId) {
      throw new ConcealedNotFoundError();
    }

    return deps.runTransaction(async (tx) => {
      const locked = await deps.lockHomeAndExactMemberships(tx, {
        homeId: input.homeId,
        membershipIds: Object.freeze([input.actor.membershipId]),
      });

      if (locked.home.id !== input.homeId || locked.home.archivedAt !== null) {
        throw new ConcealedNotFoundError();
      }

      const actor = revalidatedActor(locked, input);

      const entry = await deps.supplies.lockSupplyEntryByHomeAndId(
        tx,
        locked.home.id,
        input.supplyEntryId,
      );
      if (entry === null) {
        throw new ConcealedNotFoundError();
      }

      const claim = await deps.supplies.lockActiveClaimByEntry(
        tx,
        locked.home.id,
        entry.id,
      );
      if (claim === null) {
        throw new SupplyClaimNotActiveError();
      }

      const authorization = decideSupplyReleaseClaim({
        actor,
        targetHomeId: locked.home.id,
        claimHomeId: claim.homeId,
        claimantMembershipId: claim.claimantMembershipId,
      });
      if (!authorization.allowed) {
        throw new ConcealedNotFoundError();
      }

      if (entry.status !== 'OPEN') {
        throw new SupplyPersistenceError();
      }

      const occurredAt = deps.clock.now();
      const persistable: ReleaseActiveClaimOwnedByMembership = Object.freeze({
        claimId: claim.id,
        homeId: locked.home.id,
        supplyEntryId: entry.id,
        claimantMembershipId: claim.claimantMembershipId,
        releasedAt: occurredAt,
      });
      const released = await deps.supplies.releaseActiveClaimOwnedByMembership(
        tx,
        persistable,
      );
      if (released === null) {
        throw new SupplyClaimNotActiveError();
      }
    });
  };
}

export function createReleaseSupplyClaimFromPool(
  pool: TransactionPool,
): ReturnType<typeof createReleaseSupplyClaim> {
  return createReleaseSupplyClaim({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeAndExactMemberships,
    supplies: createSupplyRepository(
      pool as Parameters<typeof createSupplyRepository>[0],
    ),
    clock: systemClock,
  });
}
