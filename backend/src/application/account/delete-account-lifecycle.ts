import { lockActiveHomeStructureForEntry } from '../../domains/homes/lock-home-structure.js';
import type {
  LockedHomeEntryStructure,
  LockedHomeStructure,
} from '../../domains/homes/locked-home-structure.js';
import { decideArchiveFinalMember } from '../../domains/homes/policies.js';
import { StructuralIntegrityError } from '../../domains/homes/structure-errors.js';
import { evaluateHomeStructureInvariant } from '../../domains/homes/structure-invariant.js';
import {
  createEraseInvitationsForTargetEmailFromPool,
  type EraseInvitationsForTargetEmail,
} from '../../domains/invitations/erase-invitations-for-target-email.js';
import { LastAdminRequiredError } from '../../domains/memberships/errors.js';
import { decideMembershipLeave } from '../../domains/memberships/leave-policy.js';
import {
  listUserMembershipTenures,
  type UserMembershipTenure,
} from '../../domains/memberships/list-user-membership-tenures.js';
import {
  createCanonicalUserDeletionMarkerPersistence,
  type LockedCanonicalUser,
} from '../../domains/users/canonical-user-deletion-marker.js';
import {
  AuthInfrastructureError,
  authLifecycleIdentityFromCurrent,
  createAuthIdentityTeardownPersistence,
  findCurrentCanonicalIdentityByUser,
  type AuthIdentityTeardownPersistence,
  type AuthLifecycleIdentity,
  type CurrentCanonicalIdentity,
} from '../../platform/auth/index.js';
import {
  runInReadCommittedTransaction,
  type TransactionContext,
  type TransactionPool,
} from '../../platform/persistence/transaction.js';
import type { Clock } from '../../platform/time/clock.js';
import { systemClock } from '../../platform/time/clock.js';
import {
  createApplyArchiveFinalMemberHomeFromPool,
  type ApplyArchiveFinalMemberHome,
} from '../home-administration/apply-archive-final-member-home.js';
import {
  createEndMembershipWithinHomeStructureFromPool,
  type EndMembershipWithinHomeStructure,
} from '../home-administration/end-membership-within-home-structure.js';
import {
  createEraseAuthoredMaintenanceFromPool,
  type EraseAuthoredMaintenance,
} from '../maintenance/erase-authored-maintenance.js';

/**
 * Authenticated canonical User id only. HTTP must not pass a body userId.
 */
export type DeleteAccountLifecycleInput = Readonly<{
  userId: string;
}>;

export type DeleteAccountLifecycleResult = Readonly<{
  outcome: 'completed' | 'already_deleted';
}>;

export type DeleteAccountLifecycleHooks = Readonly<{
  afterUserLocked?: (tx: TransactionContext) => Promise<void>;
  afterIdentityCaptured?: (tx: TransactionContext) => Promise<void>;
  afterTenuresDiscovered?: (tx: TransactionContext) => Promise<void>;
  afterHomesLocked?: (tx: TransactionContext) => Promise<void>;
  afterGlobalPreflight?: (tx: TransactionContext) => Promise<void>;
  afterFirstStructuralMutation?: (tx: TransactionContext) => Promise<void>;
  afterMaintenanceErasure?: (tx: TransactionContext) => Promise<void>;
  afterInvitationErasure?: (tx: TransactionContext) => Promise<void>;
  afterUserDeletedAtMark?: (tx: TransactionContext) => Promise<void>;
  afterAuthTeardown?: (tx: TransactionContext) => Promise<void>;
  beforeCommit?: (tx: TransactionContext) => Promise<void>;
}>;

export type DeleteAccountLifecycleDependencies = Readonly<{
  runTransaction: <T>(
    work: (tx: TransactionContext) => Promise<T>,
  ) => Promise<T>;
  lockCanonicalUser: (
    tx: TransactionContext,
    userId: string,
  ) => Promise<LockedCanonicalUser | null>;
  findCanonicalIdentity: (
    tx: TransactionContext,
    userId: string,
  ) => Promise<CurrentCanonicalIdentity | null>;
  listTenures: (
    tx: TransactionContext,
    userId: string,
  ) => Promise<readonly UserMembershipTenure[]>;
  lockHomeEntry: (
    tx: TransactionContext,
    input: { homeId: string },
  ) => Promise<LockedHomeEntryStructure>;
  clock: Clock;
  applyArchive: ApplyArchiveFinalMemberHome;
  endMembership: EndMembershipWithinHomeStructure;
  eraseMaintenance: EraseAuthoredMaintenance;
  eraseInvitations: EraseInvitationsForTargetEmail;
  markDeleted: (
    tx: TransactionContext,
    input: Readonly<{ userId: string; deletedAt: Date }>,
  ) => Promise<number>;
  teardownAuth: AuthIdentityTeardownPersistence;
  hooks?: DeleteAccountLifecycleHooks;
}>;

type ActiveHomeDecision = Readonly<
  | {
      kind: 'leave';
      homeId: string;
      membershipId: string;
    }
  | {
      kind: 'archive';
      homeId: string;
      membershipId: string;
    }
>;

function uniqueSortedHomeIds(
  tenures: readonly UserMembershipTenure[],
): readonly string[] {
  return Object.freeze(
    [...new Set(tenures.map((tenure) => tenure.homeId))].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

function historicalMembershipIds(
  tenures: readonly UserMembershipTenure[],
): readonly string[] {
  return Object.freeze(tenures.map((tenure) => tenure.membershipId));
}

function deletingActiveMembership(
  locked: LockedHomeEntryStructure,
  userId: string,
) {
  const matches = locked.activeMemberships.filter(
    (membership) => membership.userId === userId,
  );
  if (matches.length > 1) {
    throw new StructuralIntegrityError();
  }
  return matches[0];
}

function decideActiveHome(
  locked: LockedHomeEntryStructure,
  userId: string,
): ActiveHomeDecision | null {
  const invariant = evaluateHomeStructureInvariant({
    archived: locked.home.archived,
    activeMemberships: locked.activeMemberships,
  });
  if (!invariant.ok) {
    throw new StructuralIntegrityError();
  }

  const membership = deletingActiveMembership(locked, userId);
  if (membership === undefined) {
    return null;
  }
  if (locked.home.archived) {
    throw new StructuralIntegrityError();
  }

  const leave = decideMembershipLeave({
    actorMembershipId: membership.id,
    activeMemberships: locked.activeMemberships,
  });
  if (leave.allowed) {
    return Object.freeze({
      kind: 'leave',
      homeId: locked.home.id,
      membershipId: membership.id,
    });
  }
  if (leave.reason === 'LAST_ADMIN_REQUIRED') {
    throw new LastAdminRequiredError();
  }

  const actorStructure: LockedHomeStructure = Object.freeze({
    home: Object.freeze({ id: locked.home.id }),
    actor: Object.freeze({
      userId: membership.userId,
      membershipId: membership.id,
      homeId: membership.homeId,
      role: membership.role,
    }),
    activeMemberships: locked.activeMemberships,
  });
  const archive = decideArchiveFinalMember(actorStructure);
  if (!archive.allowed) {
    throw new StructuralIntegrityError();
  }
  return Object.freeze({
    kind: 'archive',
    homeId: locked.home.id,
    membershipId: membership.id,
  });
}

function requireLifecycleIdentity(
  identity: CurrentCanonicalIdentity | null,
  userId: string,
): AuthLifecycleIdentity {
  if (identity === null || identity.userId !== userId) {
    throw new AuthInfrastructureError();
  }
  return authLifecycleIdentityFromCurrent(identity);
}

/**
 * Roomies-owned account database lifecycle. Owns exactly one READ COMMITTED
 * transaction. HTTP authentication, confirmation, cookie expiry, and the
 * future account HTTP command are out of scope.
 */
export function createDeleteAccountLifecycle(
  deps: DeleteAccountLifecycleDependencies,
): (
  input: DeleteAccountLifecycleInput,
) => Promise<DeleteAccountLifecycleResult> {
  const hooks = deps.hooks ?? {};

  return async (input) => {
    return deps.runTransaction(async (tx) => {
      const lockedUser = await deps.lockCanonicalUser(tx, input.userId);
      if (lockedUser === null) {
        throw new StructuralIntegrityError();
      }
      await hooks.afterUserLocked?.(tx);

      if (lockedUser.deletedAt !== null) {
        return Object.freeze({ outcome: 'already_deleted' as const });
      }

      const identity = requireLifecycleIdentity(
        await deps.findCanonicalIdentity(tx, lockedUser.userId),
        lockedUser.userId,
      );
      await hooks.afterIdentityCaptured?.(tx);

      const tenures = await deps.listTenures(tx, lockedUser.userId);
      const membershipIds = historicalMembershipIds(tenures);
      const homeIds = uniqueSortedHomeIds(tenures);
      await hooks.afterTenuresDiscovered?.(tx);

      const lockedHomes: LockedHomeEntryStructure[] = [];
      for (const homeId of homeIds) {
        lockedHomes.push(await deps.lockHomeEntry(tx, { homeId }));
      }
      await hooks.afterHomesLocked?.(tx);

      const decisions: ActiveHomeDecision[] = [];
      for (const locked of lockedHomes) {
        const decision = decideActiveHome(locked, lockedUser.userId);
        if (decision !== null) {
          decisions.push(decision);
        }
      }
      await hooks.afterGlobalPreflight?.(tx);

      const occurredAt = deps.clock.now();
      let mutated = false;
      for (const decision of decisions) {
        if (decision.kind === 'archive') {
          await deps.applyArchive(tx, {
            homeId: decision.homeId,
            membershipId: decision.membershipId,
            archivedAt: occurredAt,
          });
        } else {
          await deps.endMembership(tx, {
            homeId: decision.homeId,
            membershipId: decision.membershipId,
            endedAt: occurredAt,
            endedByMembershipId: decision.membershipId,
            cause: 'VOLUNTARY_LEAVE',
          });
        }
        if (!mutated) {
          mutated = true;
          await hooks.afterFirstStructuralMutation?.(tx);
        }
      }

      await deps.eraseMaintenance(tx, { membershipIds });
      await hooks.afterMaintenanceErasure?.(tx);

      await deps.eraseInvitations(tx, { invitedEmail: identity.email });
      await hooks.afterInvitationErasure?.(tx);

      const marked = await deps.markDeleted(tx, {
        userId: lockedUser.userId,
        deletedAt: occurredAt,
      });
      if (marked !== 1) {
        throw new StructuralIntegrityError();
      }
      await hooks.afterUserDeletedAtMark?.(tx);

      await deps.teardownAuth.teardownAuthForIdentity(tx, identity);
      await hooks.afterAuthTeardown?.(tx);
      await hooks.beforeCommit?.(tx);

      return Object.freeze({ outcome: 'completed' as const });
    });
  };
}

export type DeleteAccountLifecycleFromPoolOptions = Readonly<{
  clock?: Clock;
  hooks?: DeleteAccountLifecycleHooks;
  lockCanonicalUser?: DeleteAccountLifecycleDependencies['lockCanonicalUser'];
  applyArchive?: ApplyArchiveFinalMemberHome;
  endMembership?: EndMembershipWithinHomeStructure;
  eraseMaintenance?: EraseAuthoredMaintenance;
  eraseInvitations?: EraseInvitationsForTargetEmail;
  teardownAuth?: AuthIdentityTeardownPersistence;
}>;

export function createDeleteAccountLifecycleFromPool(
  pool: TransactionPool,
  options: DeleteAccountLifecycleFromPoolOptions = {},
): ReturnType<typeof createDeleteAccountLifecycle> {
  const users = createCanonicalUserDeletionMarkerPersistence();
  return createDeleteAccountLifecycle({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockCanonicalUser:
      options.lockCanonicalUser ??
      ((tx, userId) => users.lockByUserId(tx, userId)),
    findCanonicalIdentity: findCurrentCanonicalIdentityByUser,
    listTenures: listUserMembershipTenures,
    lockHomeEntry: lockActiveHomeStructureForEntry,
    clock: options.clock ?? systemClock,
    applyArchive:
      options.applyArchive ?? createApplyArchiveFinalMemberHomeFromPool(pool),
    endMembership:
      options.endMembership ??
      createEndMembershipWithinHomeStructureFromPool(pool),
    eraseMaintenance:
      options.eraseMaintenance ?? createEraseAuthoredMaintenanceFromPool(pool),
    eraseInvitations:
      options.eraseInvitations ??
      createEraseInvitationsForTargetEmailFromPool(
        pool as Parameters<
          typeof createEraseInvitationsForTargetEmailFromPool
        >[0],
      ),
    markDeleted: (tx, input) => users.markDeleted(tx, input),
    teardownAuth:
      options.teardownAuth ?? createAuthIdentityTeardownPersistence(),
    hooks: options.hooks,
  });
}
