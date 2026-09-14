import {
  lockHomeAndExactMemberships,
  type LockedHomeAndExactMemberships,
} from '../../domains/homes/lock-home-and-exact-memberships.js';
import { decideMaintenanceCreate } from '../../domains/maintenance/create-policy.js';
import {
  InvalidMaintenanceDetailsError,
  InvalidMaintenanceTitleError,
} from '../../domains/maintenance/errors.js';
import type {
  MaintenanceDetailProjection,
  MaintenanceEntry,
} from '../../domains/maintenance/maintenance.js';
import { isMaintenanceVisibility } from '../../domains/maintenance/maintenance.js';
import { normalizeMaintenanceDetails } from '../../domains/maintenance/maintenance-details.js';
import { normalizeMaintenanceTitle } from '../../domains/maintenance/maintenance-title.js';
import { createMaintenanceCreatedV1Event } from '../../domains/maintenance/events.js';
import {
  createMaintenanceRepository,
  type InsertMaintenanceEntryWithAudience,
  type MaintenanceRepository,
  type NewMaintenanceEntry,
} from '../../domains/maintenance/repository.js';
import {
  findActiveExactMembershipIdsInHome,
  type FindActiveExactMembershipIdsInHome,
} from '../../domains/memberships/find-active-exact-membership-ids-in-home.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  InvalidRequestError,
} from '../../platform/authz/errors.js';
import type { OutboxWriter } from '../../platform/events/outbox-writer.js';
import { outboxWriter } from '../../platform/events/outbox-writer.js';
import { pathUuidSchema } from '../../platform/http/path-id.js';
import type { UuidV7Generator } from '../../platform/ids/uuid-v7.js';
import { systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import {
  runInReadCommittedTransaction,
  type TransactionContext,
  type TransactionPool,
} from '../../platform/persistence/transaction.js';
import type { Clock } from '../../platform/time/clock.js';
import { systemClock } from '../../platform/time/clock.js';

export type CreateMaintenanceEntryInput = Readonly<{
  actor: ActiveHomeActor;
  homeId: string;
  visibility: unknown;
  title: string;
  details?: string | null;
  audienceMembershipIds?: readonly string[];
}>;

export type LockHomeAndExactMemberships = (
  tx: TransactionContext,
  input: {
    homeId: string;
    membershipIds: readonly string[];
  },
) => Promise<LockedHomeAndExactMemberships>;

export type CreateMaintenanceEntryDependencies = Readonly<{
  runTransaction: <T>(
    work: (tx: TransactionContext) => Promise<T>,
  ) => Promise<T>;
  lockHomeAndExactMemberships: LockHomeAndExactMemberships;
  findActiveExactMembershipIdsInHome: FindActiveExactMembershipIdsInHome;
  maintenance: Pick<MaintenanceRepository, 'insertEntryWithAudience'>;
  outbox: Pick<OutboxWriter, 'append'>;
  clock: Clock;
  ids: UuidV7Generator;
}>;

function requiredUuid(value: string): string {
  const parsed = pathUuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidRequestError();
  }
  return parsed.data;
}

function normalizedTitle(value: string): string {
  try {
    return normalizeMaintenanceTitle(value);
  } catch (error) {
    if (error instanceof InvalidMaintenanceTitleError) {
      throw new InvalidRequestError();
    }
    throw error;
  }
}

function normalizedDetails(value: string | null | undefined): string | null {
  try {
    return normalizeMaintenanceDetails(value);
  } catch (error) {
    if (error instanceof InvalidMaintenanceDetailsError) {
      throw new InvalidRequestError();
    }
    throw error;
  }
}

function uniqueSortedMembershipIds(
  membershipIds: readonly string[],
): readonly string[] {
  const unique = new Set<string>();
  for (const membershipId of membershipIds) {
    unique.add(requiredUuid(membershipId));
  }
  return Object.freeze(
    [...unique].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

function sameMembershipIdSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((membershipId, index) => membershipId === right[index]);
}

function toCreateProjection(
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

function revalidatedActor(
  locked: LockedHomeAndExactMemberships,
  input: CreateMaintenanceEntryInput,
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

function normalizedPrivateAudience(
  actorMembershipId: string,
  audienceMembershipIds: readonly string[],
): readonly string[] {
  return uniqueSortedMembershipIds([
    ...audienceMembershipIds,
    actorMembershipId,
  ]);
}

function validatedCreateShape(input: CreateMaintenanceEntryInput): Readonly<{
  title: string;
  details: string | null;
  visibility: 'HOUSEHOLD' | 'PRIVATE';
  audienceMembershipIds: readonly string[];
}> {
  if (!isMaintenanceVisibility(input.visibility)) {
    throw new InvalidRequestError();
  }

  const hasAudienceProperty = Object.hasOwn(input, 'audienceMembershipIds');
  if (input.visibility === 'HOUSEHOLD') {
    if (hasAudienceProperty) {
      throw new InvalidRequestError();
    }
    return Object.freeze({
      title: normalizedTitle(input.title),
      details: normalizedDetails(input.details),
      visibility: 'HOUSEHOLD',
      audienceMembershipIds: Object.freeze([]),
    });
  }

  if (!hasAudienceProperty || !Array.isArray(input.audienceMembershipIds)) {
    throw new InvalidRequestError();
  }

  return Object.freeze({
    title: normalizedTitle(input.title),
    details: normalizedDetails(input.details),
    visibility: 'PRIVATE',
    audienceMembershipIds: normalizedPrivateAudience(
      input.actor.membershipId,
      input.audienceMembershipIds,
    ),
  });
}

/**
 * Creates one OPEN MaintenanceEntry for an authorized Home.
 *
 * Mutation order inside READ COMMITTED:
 * Home FOR UPDATE → exact actor Membership FOR UPDATE → revalidate Home →
 * revalidate exact actor tenure/user/home/current DB role → authorize
 * maintenance.create → validate/normalize input → PRIVATE audience
 * validation under the held Home lock → one Clock.now() + entry UUIDv7 →
 * insertEntryWithAudience → same-transaction maintenance.created.v1.
 */
export function createCreateMaintenanceEntry(
  deps: CreateMaintenanceEntryDependencies,
): (
  input: CreateMaintenanceEntryInput,
) => Promise<MaintenanceDetailProjection> {
  return async (input) => {
    requiredUuid(input.homeId);
    requiredUuid(input.actor.membershipId);

    return deps.runTransaction(async (tx) => {
      const locked = await deps.lockHomeAndExactMemberships(tx, {
        homeId: input.homeId,
        membershipIds: Object.freeze([input.actor.membershipId]),
      });

      const actor = revalidatedActor(locked, input);
      const authorization = decideMaintenanceCreate({
        actor,
        targetHomeId: locked.home.id,
      });
      if (!authorization.allowed) {
        throw new ConcealedNotFoundError();
      }

      const shape = validatedCreateShape({
        ...input,
        actor,
      });

      if (shape.visibility === 'PRIVATE') {
        const activeSameHomeIds = await deps.findActiveExactMembershipIdsInHome(
          tx,
          {
            homeId: locked.home.id,
            membershipIds: shape.audienceMembershipIds,
          },
        );
        if (
          !sameMembershipIdSet(shape.audienceMembershipIds, activeSameHomeIds)
        ) {
          throw new ConcealedNotFoundError();
        }
      }

      const occurredAt = deps.clock.now();
      const entryId = deps.ids.next();
      const persistable: NewMaintenanceEntry = Object.freeze({
        id: entryId,
        homeId: locked.home.id,
        createdByMembershipId: actor.membershipId,
        visibility: shape.visibility,
        title: shape.title,
        details: shape.details,
        status: 'OPEN',
        resolvedByMembershipId: null,
        resolvedAt: null,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      });
      const insert: InsertMaintenanceEntryWithAudience = Object.freeze({
        entry: persistable,
        audienceMembershipIds: shape.audienceMembershipIds,
      });
      const created = await deps.maintenance.insertEntryWithAudience(
        tx,
        insert,
      );
      await deps.outbox.append(
        tx,
        createMaintenanceCreatedV1Event({
          eventId: deps.ids.next(),
          occurredAt,
          homeId: locked.home.id,
          maintenanceEntryId: created.id,
        }),
      );
      return toCreateProjection(created);
    });
  };
}

export function createCreateMaintenanceEntryFromPool(
  pool: TransactionPool,
): ReturnType<typeof createCreateMaintenanceEntry> {
  return createCreateMaintenanceEntry({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeAndExactMemberships,
    findActiveExactMembershipIdsInHome,
    maintenance: createMaintenanceRepository(
      pool as Parameters<typeof createMaintenanceRepository>[0],
    ),
    outbox: outboxWriter,
    clock: systemClock,
    ids: systemUuidV7,
  });
}
