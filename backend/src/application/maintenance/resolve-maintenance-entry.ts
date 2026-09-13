import {
  lockHomeAndExactMemberships,
  type LockedHomeAndExactMemberships,
} from '../../domains/homes/lock-home-and-exact-memberships.js';
import {
  MaintenanceNotOpenError,
  MaintenancePersistenceError,
} from '../../domains/maintenance/errors.js';
import type {
  MaintenanceDetailProjection,
  MaintenanceEntry,
} from '../../domains/maintenance/maintenance.js';
import { decideMaintenanceResolve } from '../../domains/maintenance/resolve-policy.js';
import {
  createMaintenanceRepository,
  type MaintenanceRepository,
  type ResolveOpenMaintenanceEntry,
} from '../../domains/maintenance/repository.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  InvalidRequestError,
} from '../../platform/authz/errors.js';
import { pathUuidSchema } from '../../platform/http/path-id.js';
import {
  runInReadCommittedTransaction,
  type TransactionContext,
  type TransactionPool,
} from '../../platform/persistence/transaction.js';
import type { Clock } from '../../platform/time/clock.js';
import { systemClock } from '../../platform/time/clock.js';
import type { LockHomeAndExactMemberships } from './create-maintenance-entry.js';

export type ResolveMaintenanceEntryInput = Readonly<{
  actor: ActiveHomeActor;
  homeId: string;
  maintenanceEntryId: string;
}>;

export type ResolveMaintenanceEntryDependencies = Readonly<{
  runTransaction: <T>(
    work: (tx: TransactionContext) => Promise<T>,
  ) => Promise<T>;
  lockHomeAndExactMemberships: LockHomeAndExactMemberships;
  maintenance: Pick<
    MaintenanceRepository,
    'lockVisibleForResolve' | 'resolveOpenEntry'
  >;
  clock: Clock;
}>;

function requiredUuid(value: string): string {
  const parsed = pathUuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidRequestError();
  }
  return parsed.data;
}

function revalidatedActor(
  locked: LockedHomeAndExactMemberships,
  input: ResolveMaintenanceEntryInput,
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

function toDetailProjection(
  entry: MaintenanceEntry,
): MaintenanceDetailProjection {
  return Object.freeze({
    id: entry.id,
    title: entry.title,
    details: entry.details,
    status: entry.status,
    visibility: entry.visibility,
    createdByMembershipId: entry.createdByMembershipId,
    resolvedByMembershipId: entry.resolvedByMembershipId,
    resolvedAt: entry.resolvedAt,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  });
}

/**
 * Resolves one visible OPEN MaintenanceEntry for an authorized Home actor.
 *
 * Mutation order inside READ COMMITTED:
 * Home FOR UPDATE → exact actor Membership FOR UPDATE → revalidate Home →
 * revalidate exact actor tenure/user/home/current DB role → authorize
 * maintenance.resolve → visible MaintenanceEntry FOR UPDATE → require OPEN →
 * one Clock.now() → conditional resolve write.
 */
export function createResolveMaintenanceEntry(
  deps: ResolveMaintenanceEntryDependencies,
): (
  input: ResolveMaintenanceEntryInput,
) => Promise<MaintenanceDetailProjection> {
  return async (input) => {
    requiredUuid(input.homeId);
    requiredUuid(input.actor.membershipId);
    requiredUuid(input.maintenanceEntryId);

    return deps.runTransaction(async (tx) => {
      const locked = await deps.lockHomeAndExactMemberships(tx, {
        homeId: input.homeId,
        membershipIds: Object.freeze([input.actor.membershipId]),
      });

      const actor = revalidatedActor(locked, input);
      const authorization = decideMaintenanceResolve({
        actor,
        targetHomeId: locked.home.id,
      });
      if (!authorization.allowed) {
        throw new ConcealedNotFoundError();
      }

      const entry = await deps.maintenance.lockVisibleForResolve(
        tx,
        locked.home.id,
        input.maintenanceEntryId,
        actor.membershipId,
      );
      if (entry === null) {
        throw new ConcealedNotFoundError();
      }
      if (entry.status !== 'OPEN') {
        throw new MaintenanceNotOpenError();
      }

      const occurredAt = deps.clock.now();
      const persistable: ResolveOpenMaintenanceEntry = Object.freeze({
        homeId: locked.home.id,
        maintenanceEntryId: entry.id,
        resolverMembershipId: actor.membershipId,
        resolvedAt: occurredAt,
      });
      const updated = await deps.maintenance.resolveOpenEntry(tx, persistable);
      if (updated === null) {
        throw new MaintenancePersistenceError();
      }
      return toDetailProjection(updated);
    });
  };
}

export function createResolveMaintenanceEntryFromPool(
  pool: TransactionPool,
): ReturnType<typeof createResolveMaintenanceEntry> {
  return createResolveMaintenanceEntry({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeAndExactMemberships,
    maintenance: createMaintenanceRepository(
      pool as Parameters<typeof createMaintenanceRepository>[0],
    ),
    clock: systemClock,
  });
}
