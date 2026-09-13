import {
  lockHomeAndExactMemberships,
  type LockedHomeAndExactMemberships,
} from '../../domains/homes/lock-home-and-exact-memberships.js';
import {
  SupplyNotOpenError,
  SupplyPersistenceError,
} from '../../domains/supplies/errors.js';
import { decideSupplyMarkObtained } from '../../domains/supplies/obtain-policy.js';
import {
  createSupplyRepository,
  type ReleaseActiveClaimForEntryTerminalization,
  type SupplyRepository,
  type TerminalizeSupplyEntryAsObtained,
} from '../../domains/supplies/repository.js';
import type { SupplyEntry } from '../../domains/supplies/supply.js';
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

export type MarkSupplyEntryObtainedInput = Readonly<{
  actor: ActiveHomeActor;
  homeId: string;
  supplyEntryId: string;
}>;

export type MarkSupplyEntryObtainedDependencies = Readonly<{
  runTransaction: <T>(
    work: (tx: TransactionContext) => Promise<T>,
  ) => Promise<T>;
  lockHomeAndExactMemberships: LockHomeAndExactMemberships;
  supplies: Pick<
    SupplyRepository,
    | 'lockSupplyEntryByHomeAndId'
    | 'lockActiveClaimByEntry'
    | 'releaseActiveClaimForEntryTerminalization'
    | 'terminalizeSupplyEntryAsObtained'
  >;
  clock: Clock;
}>;

function revalidatedActor(
  locked: LockedHomeAndExactMemberships,
  input: MarkSupplyEntryObtainedInput,
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

function isCompleteOpenMatrix(entry: SupplyEntry): boolean {
  return (
    entry.status === 'OPEN' &&
    entry.obtainedAt === null &&
    entry.canceledAt === null
  );
}

/**
 * Marks one OPEN SupplyEntry OBTAINED for an authorized Home actor.
 *
 * Mutation order inside READ COMMITTED:
 * Home FOR UPDATE → exact actor Membership FOR UPDATE → revalidate Home →
 * revalidate exact actor tenure/user/home/current DB role → authorize
 * supply.mark_obtained → SupplyEntry FOR UPDATE → complete OPEN matrix →
 * active SupplyClaim FOR UPDATE → one Clock.now() → optional ENTRY_OBTAINED
 * release → conditional OBTAINED terminalization.
 */
export function createMarkSupplyEntryObtained(
  deps: MarkSupplyEntryObtainedDependencies,
): (input: MarkSupplyEntryObtainedInput) => Promise<SupplyEntry> {
  return async (input) => {
    const early = decideSupplyMarkObtained({
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
      const authorization = decideSupplyMarkObtained({
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
      if (!isCompleteOpenMatrix(entry)) {
        throw new SupplyNotOpenError();
      }

      const claim = await deps.supplies.lockActiveClaimByEntry(
        tx,
        locked.home.id,
        entry.id,
      );

      const occurredAt = deps.clock.now();
      if (claim !== null) {
        const persistable: ReleaseActiveClaimForEntryTerminalization =
          Object.freeze({
            claimId: claim.id,
            homeId: locked.home.id,
            supplyEntryId: entry.id,
            releasedAt: occurredAt,
            reason: 'ENTRY_OBTAINED',
          });
        const released =
          await deps.supplies.releaseActiveClaimForEntryTerminalization(
            tx,
            persistable,
          );
        if (released === null) {
          throw new SupplyPersistenceError();
        }
      }

      const terminalize: TerminalizeSupplyEntryAsObtained = Object.freeze({
        supplyEntryId: entry.id,
        homeId: locked.home.id,
        obtainedAt: occurredAt,
      });
      const updated = await deps.supplies.terminalizeSupplyEntryAsObtained(
        tx,
        terminalize,
      );
      if (updated === null) {
        throw new SupplyPersistenceError();
      }
      return updated;
    });
  };
}

export function createMarkSupplyEntryObtainedFromPool(
  pool: TransactionPool,
): ReturnType<typeof createMarkSupplyEntryObtained> {
  return createMarkSupplyEntryObtained({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeAndExactMemberships,
    supplies: createSupplyRepository(
      pool as Parameters<typeof createSupplyRepository>[0],
    ),
    clock: systemClock,
  });
}
