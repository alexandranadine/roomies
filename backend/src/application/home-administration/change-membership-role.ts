import { StructuralIntegrityError } from '../../domains/homes/structure-errors.js';
import { evaluateHomeStructureInvariant } from '../../domains/homes/structure-invariant.js';
import type { LockedHomeStructure } from '../../domains/homes/locked-home-structure.js';
import { lockHomeStructure } from '../../domains/homes/lock-home-structure.js';
import { createMembershipRoleChangedV1Event } from '../../domains/memberships/events.js';
import { LastAdminRequiredError } from '../../domains/memberships/errors.js';
import {
  decideMembershipChangeRole,
  decideProposedAdminInvariant,
} from '../../domains/memberships/role-policy.js';
import {
  createMembershipRoleWriter,
  type MembershipRoleWriter,
} from '../../domains/memberships/update-active-membership-role.js';
import type { ChangeMembershipRoleInput } from '../../domains/memberships/change-role.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  ForbiddenError,
} from '../../platform/authz/errors.js';
import type { OutboxWriter } from '../../platform/events/outbox-writer.js';
import { outboxWriter } from '../../platform/events/outbox-writer.js';
import type { UuidV7Generator } from '../../platform/ids/uuid-v7.js';
import { systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import {
  runInReadCommittedTransaction,
  type TransactionContext,
  type TransactionPool,
} from '../../platform/persistence/transaction.js';
import type { Clock } from '../../platform/time/clock.js';
import { systemClock } from '../../platform/time/clock.js';

export type ChangeMembershipRoleResult =
  | { readonly changed: false }
  | {
      readonly changed: true;
      readonly previousRole: ActiveHomeActor['role'];
      readonly newRole: ActiveHomeActor['role'];
    };

export type ChangeMembershipRoleDependencies = {
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
  outbox: Pick<OutboxWriter, 'append'>;
  clock: Clock;
  ids: UuidV7Generator;
  roleWriter: MembershipRoleWriter;
};

export function createChangeMembershipRole(
  deps: ChangeMembershipRoleDependencies,
): (input: ChangeMembershipRoleInput) => Promise<ChangeMembershipRoleResult> {
  return async (input) => {
    const occurredAt = deps.clock.now();

    return deps.runTransaction(async (tx) => {
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

      const target = locked.activeMemberships.find(
        (membership) =>
          membership.id === input.membershipId &&
          membership.homeId === locked.home.id,
      );
      if (target === undefined) {
        throw new ConcealedNotFoundError();
      }

      const authorization = decideMembershipChangeRole({
        actorRole: locked.actor.role,
      });
      if (!authorization.allowed) {
        throw new ForbiddenError();
      }

      if (target.role === input.role) {
        return { changed: false };
      }

      const proposedActiveMemberships = locked.activeMemberships.map(
        (membership) =>
          membership.id === target.id
            ? { role: input.role }
            : { role: membership.role },
      );
      const proposed = decideProposedAdminInvariant({
        proposedActiveMemberships,
      });
      if (!proposed.allowed) {
        throw new LastAdminRequiredError();
      }

      const updated = await deps.roleWriter.updateActiveRole(tx, {
        membershipId: target.id,
        homeId: locked.home.id,
        previousRole: target.role,
        newRole: input.role,
      });
      if (updated !== 1) {
        throw new StructuralIntegrityError();
      }

      await deps.outbox.append(
        tx,
        createMembershipRoleChangedV1Event({
          eventId: deps.ids.next(),
          occurredAt,
          membershipId: target.id,
          previousRole: target.role,
          newRole: input.role,
          homeId: locked.home.id,
        }),
      );

      return {
        changed: true,
        previousRole: target.role,
        newRole: input.role,
      };
    });
  };
}

export function createChangeMembershipRoleFromPool(
  pool: TransactionPool,
): ReturnType<typeof createChangeMembershipRole> {
  return createChangeMembershipRole({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeStructure,
    outbox: outboxWriter,
    clock: systemClock,
    ids: systemUuidV7,
    roleWriter: createMembershipRoleWriter(),
  });
}
