import {
  lockHomeAndExactMemberships,
  type LockedHomeAndExactMemberships,
} from '../../domains/homes/lock-home-and-exact-memberships.js';
import { decideSupplyCreate } from '../../domains/supplies/create-policy.js';
import { InvalidSupplyTitleError } from '../../domains/supplies/errors.js';
import {
  createSupplyRepository,
  type NewSupplyEntry,
  type SupplyRepository,
} from '../../domains/supplies/repository.js';
import type { SupplyEntry } from '../../domains/supplies/supply.js';
import { normalizeSupplyTitle } from '../../domains/supplies/supply-title.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  InvalidRequestError,
} from '../../platform/authz/errors.js';
import type { UuidV7Generator } from '../../platform/ids/uuid-v7.js';
import { systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import {
  runInReadCommittedTransaction,
  type TransactionContext,
  type TransactionPool,
} from '../../platform/persistence/transaction.js';
import type { Clock } from '../../platform/time/clock.js';
import { systemClock } from '../../platform/time/clock.js';

export type CreateSupplyEntryInput = Readonly<{
  actor: ActiveHomeActor;
  homeId: string;
  title: string;
}>;

export type LockHomeAndExactMemberships = (
  tx: TransactionContext,
  input: {
    homeId: string;
    membershipIds: readonly string[];
  },
) => Promise<LockedHomeAndExactMemberships>;

export type CreateSupplyEntryDependencies = Readonly<{
  runTransaction: <T>(
    work: (tx: TransactionContext) => Promise<T>,
  ) => Promise<T>;
  lockHomeAndExactMemberships: LockHomeAndExactMemberships;
  supplies: Pick<SupplyRepository, 'insertSupplyEntry'>;
  clock: Clock;
  ids: UuidV7Generator;
}>;

function normalizedTitle(value: string): string {
  try {
    return normalizeSupplyTitle(value);
  } catch (error) {
    if (error instanceof InvalidSupplyTitleError) {
      throw new InvalidRequestError();
    }
    throw error;
  }
}

function revalidatedActor(
  locked: LockedHomeAndExactMemberships,
  input: CreateSupplyEntryInput,
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
 * Creates one OPEN SupplyEntry for an authorized Home.
 *
 * Mutation order inside READ COMMITTED:
 * Home FOR UPDATE → exact actor Membership FOR UPDATE → revalidate Home →
 * revalidate exact actor tenure/user/home/current DB role → authorize
 * supply.create → UUIDv7 + one Clock.now() → INSERT.
 */
export function createCreateSupplyEntry(
  deps: CreateSupplyEntryDependencies,
): (input: CreateSupplyEntryInput) => Promise<SupplyEntry> {
  return async (input) => {
    const early = decideSupplyCreate({
      actor: input.actor,
      targetHomeId: input.homeId,
    });
    if (!early.allowed) {
      throw new ConcealedNotFoundError();
    }

    const title = normalizedTitle(input.title);

    return deps.runTransaction(async (tx) => {
      const locked = await deps.lockHomeAndExactMemberships(tx, {
        homeId: input.homeId,
        membershipIds: Object.freeze([input.actor.membershipId]),
      });

      if (locked.home.id !== input.homeId || locked.home.archivedAt !== null) {
        throw new ConcealedNotFoundError();
      }

      const actor = revalidatedActor(locked, input);
      const authorization = decideSupplyCreate({
        actor,
        targetHomeId: locked.home.id,
      });
      if (!authorization.allowed) {
        throw new ConcealedNotFoundError();
      }

      const entryId = deps.ids.next();
      const occurredAt = deps.clock.now();
      const persistable: NewSupplyEntry = Object.freeze({
        id: entryId,
        homeId: locked.home.id,
        title,
        status: 'OPEN',
        createdByMembershipId: actor.membershipId,
        obtainedAt: null,
        canceledAt: null,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      });
      return deps.supplies.insertSupplyEntry(tx, persistable);
    });
  };
}

export function createCreateSupplyEntryFromPool(
  pool: TransactionPool,
): ReturnType<typeof createCreateSupplyEntry> {
  return createCreateSupplyEntry({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeAndExactMemberships,
    supplies: createSupplyRepository(
      pool as Parameters<typeof createSupplyRepository>[0],
    ),
    clock: systemClock,
    ids: systemUuidV7,
  });
}
