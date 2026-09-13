import {
  lockHomeAndExactMemberships,
  type LockedHomeAndExactMemberships,
} from '../../domains/homes/lock-home-and-exact-memberships.js';
import { decideSupplyClaim } from '../../domains/supplies/claim-policy.js';
import {
  SupplyAlreadyClaimedError,
  SupplyNotOpenError,
} from '../../domains/supplies/errors.js';
import {
  createSupplyRepository,
  type NewSupplyClaim,
  type SupplyRepository,
} from '../../domains/supplies/repository.js';
import type { SupplyClaim } from '../../domains/supplies/supply.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import type { UuidV7Generator } from '../../platform/ids/uuid-v7.js';
import { systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import {
  runInReadCommittedTransaction,
  type TransactionContext,
  type TransactionPool,
} from '../../platform/persistence/transaction.js';
import type { Clock } from '../../platform/time/clock.js';
import { systemClock } from '../../platform/time/clock.js';
import type { LockHomeAndExactMemberships } from './create-supply-entry.js';

export type ClaimSupplyEntryInput = Readonly<{
  actor: ActiveHomeActor;
  homeId: string;
  supplyEntryId: string;
}>;

export type ClaimSupplyEntryDependencies = Readonly<{
  runTransaction: <T>(
    work: (tx: TransactionContext) => Promise<T>,
  ) => Promise<T>;
  lockHomeAndExactMemberships: LockHomeAndExactMemberships;
  supplies: Pick<
    SupplyRepository,
    | 'lockSupplyEntryByHomeAndId'
    | 'lockActiveClaimByEntry'
    | 'insertSupplyClaim'
  >;
  clock: Clock;
  ids: UuidV7Generator;
}>;

function revalidatedActor(
  locked: LockedHomeAndExactMemberships,
  input: ClaimSupplyEntryInput,
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
 * Claims one OPEN SupplyEntry for an authorized Home actor.
 *
 * Mutation order inside READ COMMITTED:
 * Home FOR UPDATE → exact actor Membership FOR UPDATE → revalidate Home →
 * revalidate exact actor tenure/user/home/current DB role → authorize
 * supply.claim → SupplyEntry FOR UPDATE → active SupplyClaim FOR UPDATE →
 * UUIDv7 + one Clock.now() → INSERT.
 */
export function createClaimSupplyEntry(
  deps: ClaimSupplyEntryDependencies,
): (input: ClaimSupplyEntryInput) => Promise<SupplyClaim> {
  return async (input) => {
    const early = decideSupplyClaim({
      actor: input.actor,
      targetHomeId: input.homeId,
    });
    if (!early.allowed) {
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
      const authorization = decideSupplyClaim({
        actor,
        targetHomeId: locked.home.id,
      });
      if (!authorization.allowed) {
        throw new ConcealedNotFoundError();
      }

      const entry = await deps.supplies.lockSupplyEntryByHomeAndId(
        tx,
        locked.home.id,
        input.supplyEntryId,
      );
      if (entry === null) {
        throw new ConcealedNotFoundError();
      }
      if (entry.status !== 'OPEN') {
        throw new SupplyNotOpenError();
      }

      const existing = await deps.supplies.lockActiveClaimByEntry(
        tx,
        locked.home.id,
        entry.id,
      );
      if (existing !== null) {
        throw new SupplyAlreadyClaimedError();
      }

      const claimId = deps.ids.next();
      const occurredAt = deps.clock.now();
      const persistable: NewSupplyClaim = Object.freeze({
        id: claimId,
        homeId: locked.home.id,
        supplyEntryId: entry.id,
        claimantMembershipId: actor.membershipId,
        claimedAt: occurredAt,
        releasedAt: null,
        releaseReason: null,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      });
      return deps.supplies.insertSupplyClaim(tx, persistable);
    });
  };
}

export function createClaimSupplyEntryFromPool(
  pool: TransactionPool,
): ReturnType<typeof createClaimSupplyEntry> {
  return createClaimSupplyEntry({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeAndExactMemberships,
    supplies: createSupplyRepository(
      pool as Parameters<typeof createSupplyRepository>[0],
    ),
    clock: systemClock,
    ids: systemUuidV7,
  });
}
