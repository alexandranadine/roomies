import { StructuralIntegrityError } from '../../domains/homes/structure-errors.js';
import {
  createMembershipEndedV1Event,
  isMembershipEndedCause,
  type MembershipEndedCause,
} from '../../domains/memberships/events.js';
import {
  createMembershipEndingWriter,
  type MembershipEndingWriter,
} from '../../domains/memberships/update-active-membership-ended-at.js';
import type { OutboxWriter } from '../../platform/events/outbox-writer.js';
import { outboxWriter } from '../../platform/events/outbox-writer.js';
import type { UuidV7Generator } from '../../platform/ids/uuid-v7.js';
import { systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import type {
  MembershipEndingSupplyCleanup,
  MembershipEndingTaskCleanup,
} from './membership-ending-cleanup.js';
import { createTemporaryNoOpMembershipEndingSupplyCleanup } from './temporary-noop-membership-ending-supply-cleanup.js';
import { createTemporaryNoOpMembershipEndingTaskCleanup } from './temporary-noop-membership-ending-task-cleanup.js';

/**
 * Exact active Membership tenure to end. The caller already locked Home then
 * active Memberships and selected this tenure. Never a userId lookup.
 */
export type EndMembershipWithinHomeStructureInput = Readonly<{
  homeId: string;
  membershipId: string;
  endedAt: Date;
  cause: MembershipEndedCause;
}>;

export type EndMembershipWithinHomeStructureResult = Readonly<{
  membershipId: string;
}>;

export type EndMembershipWithinHomeStructure = (
  tx: TransactionContext,
  input: EndMembershipWithinHomeStructureInput,
) => Promise<EndMembershipWithinHomeStructureResult>;

export type EndMembershipWithinHomeStructureDependencies = {
  taskCleanup: MembershipEndingTaskCleanup;
  supplyCleanup: MembershipEndingSupplyCleanup;
  membershipEnding: MembershipEndingWriter;
  outbox: Pick<OutboxWriter, 'append'>;
  ids: UuidV7Generator;
};

export type ApplyMembershipEndingWithinHomeStructureDependencies = Pick<
  EndMembershipWithinHomeStructureDependencies,
  'taskCleanup' | 'supplyCleanup' | 'membershipEnding'
>;

export type ApplyMembershipEndingWithinHomeStructure =
  EndMembershipWithinHomeStructure;

/**
 * Internal no-event mutation primitive for callers that must sequence another
 * structural write before appending membership.ended.v1.
 *
 * Order: Task cleanup → Supply cleanup → exact Membership ended_at.
 */
export function createApplyMembershipEndingWithinHomeStructure(
  deps: ApplyMembershipEndingWithinHomeStructureDependencies,
): ApplyMembershipEndingWithinHomeStructure {
  return async (tx, input) => {
    if (!isMembershipEndedCause(input.cause)) {
      throw new Error('Invalid membership ended cause');
    }

    const cleanupInput = Object.freeze({
      homeId: input.homeId,
      membershipId: input.membershipId,
      endedAt: input.endedAt,
      cause: input.cause,
    });

    await deps.taskCleanup.handleMembershipEnded(tx, cleanupInput);
    await deps.supplyCleanup.handleMembershipEnded(tx, cleanupInput);

    const updated = await deps.membershipEnding.endActiveMembership(tx, {
      membershipId: input.membershipId,
      homeId: input.homeId,
      endedAt: input.endedAt,
    });
    if (updated !== 1) {
      throw new StructuralIntegrityError();
    }

    return { membershipId: input.membershipId };
  };
}

/**
 * Synchronous membership-ending consequences inside an already-established
 * structural transaction. Does not begin, commit, or roll back; does not
 * lock Home; does not decide whether leave/remove/archive is permitted.
 *
 * Order: Task cleanup → Supply cleanup → Membership ended_at → outbox.
 */
export function createEndMembershipWithinHomeStructure(
  deps: EndMembershipWithinHomeStructureDependencies,
): EndMembershipWithinHomeStructure {
  const applyMembershipEnding =
    createApplyMembershipEndingWithinHomeStructure(deps);

  return async (tx, input) => {
    const result = await applyMembershipEnding(tx, input);

    await deps.outbox.append(
      tx,
      createMembershipEndedV1Event({
        eventId: deps.ids.next(),
        occurredAt: input.endedAt,
        membershipId: input.membershipId,
        cause: input.cause,
        homeId: input.homeId,
      }),
    );

    return result;
  };
}

/**
 * Composition wiring for later leave/remove/archive commands.
 *
 * Injects the temporary no-op Task and Supply adapters explicitly. Those
 * adapters MUST be replaced when M3 Tasks / M4 Supplies ship. Does not
 * acquire a pool or begin a transaction.
 */
export function createEndMembershipWithinHomeStructureWithTemporaryNoOpCleanup(): EndMembershipWithinHomeStructure {
  return createEndMembershipWithinHomeStructure({
    taskCleanup: createTemporaryNoOpMembershipEndingTaskCleanup(),
    supplyCleanup: createTemporaryNoOpMembershipEndingSupplyCleanup(),
    membershipEnding: createMembershipEndingWriter(),
    outbox: outboxWriter,
    ids: systemUuidV7,
  });
}

export function createApplyMembershipEndingWithinHomeStructureWithTemporaryNoOpCleanup(): ApplyMembershipEndingWithinHomeStructure {
  return createApplyMembershipEndingWithinHomeStructure({
    taskCleanup: createTemporaryNoOpMembershipEndingTaskCleanup(),
    supplyCleanup: createTemporaryNoOpMembershipEndingSupplyCleanup(),
    membershipEnding: createMembershipEndingWriter(),
  });
}
