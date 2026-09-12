import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StructuralIntegrityError } from '../../domains/homes/structure-errors.js';
import { MEMBERSHIP_ENDED_CAUSES } from '../../domains/memberships/events.js';
import type {
  JsonObject,
  OutboxEventInput,
} from '../../platform/events/outbox-types.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import type { MembershipEndingCleanupInput } from './membership-ending-cleanup.js';
import {
  createApplyMembershipEndingWithinHomeStructure,
  createEndMembershipWithinHomeStructure,
} from './end-membership-within-home-structure.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBERSHIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBERSHIP_OLD = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const EVENT_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const ENDED_AT = new Date('2026-03-15T12:34:56.789Z');

type Step = 'task' | 'supply' | 'membership' | 'outbox';

function commandOf(options: {
  updateRows?: number;
  taskError?: Error;
  supplyError?: Error;
  outboxError?: Error;
}) {
  const tx = {} as TransactionContext;
  const steps: Step[] = [];
  const taskInputs: MembershipEndingCleanupInput[] = [];
  const supplyInputs: MembershipEndingCleanupInput[] = [];
  const taskTxs: TransactionContext[] = [];
  const supplyTxs: TransactionContext[] = [];
  const membershipUpdates: unknown[] = [];
  const events: OutboxEventInput<string, JsonObject>[] = [];

  const endMembership = createEndMembershipWithinHomeStructure({
    taskCleanup: {
      handleMembershipEnded(receivedTx, input) {
        steps.push('task');
        taskTxs.push(receivedTx);
        taskInputs.push(input);
        if (options.taskError) {
          return Promise.reject(options.taskError);
        }
        return Promise.resolve();
      },
    },
    supplyCleanup: {
      handleMembershipEnded(receivedTx, input) {
        steps.push('supply');
        supplyTxs.push(receivedTx);
        supplyInputs.push(input);
        if (options.supplyError) {
          return Promise.reject(options.supplyError);
        }
        return Promise.resolve();
      },
    },
    membershipEnding: {
      endActiveMembership(_tx, input) {
        steps.push('membership');
        membershipUpdates.push(input);
        return Promise.resolve(options.updateRows ?? 1);
      },
    },
    outbox: {
      append(_tx, event) {
        steps.push('outbox');
        if (options.outboxError) {
          return Promise.reject(options.outboxError);
        }
        events.push(event);
        return Promise.resolve();
      },
    },
    ids: { next: () => EVENT_ID },
  });

  return {
    tx,
    endMembership,
    steps,
    taskInputs,
    supplyInputs,
    taskTxs,
    supplyTxs,
    membershipUpdates,
    events,
  };
}

void describe('endMembershipWithinHomeStructure application orchestration', () => {
  void it('exposes a narrow no-event primitive with cleanup and exact UPDATE only', async () => {
    const steps: string[] = [];
    const tx = {} as TransactionContext;
    const apply = createApplyMembershipEndingWithinHomeStructure({
      taskCleanup: {
        handleMembershipEnded: () => {
          steps.push('task');
          return Promise.resolve();
        },
      },
      supplyCleanup: {
        handleMembershipEnded: () => {
          steps.push('supply');
          return Promise.resolve();
        },
      },
      membershipEnding: {
        endActiveMembership: () => {
          steps.push('membership');
          return Promise.resolve(1);
        },
      },
    });

    await apply(tx, {
      homeId: HOME,
      membershipId: MEMBERSHIP,
      endedAt: ENDED_AT,
      cause: 'HOME_ARCHIVED',
    });
    assert.deepEqual(steps, ['task', 'supply', 'membership']);
  });

  void it('invokes Task then Supply then Membership UPDATE then outbox once each', async () => {
    const {
      tx,
      endMembership,
      steps,
      taskInputs,
      supplyInputs,
      taskTxs,
      supplyTxs,
      membershipUpdates,
      events,
    } = commandOf({});

    const result = await endMembership(tx, {
      homeId: HOME,
      membershipId: MEMBERSHIP,
      endedAt: ENDED_AT,
      cause: 'VOLUNTARY_LEAVE',
    });

    assert.deepEqual(result, { membershipId: MEMBERSHIP });
    assert.deepEqual(steps, ['task', 'supply', 'membership', 'outbox']);
    assert.equal(taskInputs.length, 1);
    assert.equal(supplyInputs.length, 1);
    assert.equal(taskTxs[0], tx);
    assert.equal(supplyTxs[0], tx);
    assert.equal(taskTxs[0], supplyTxs[0]);
    assert.equal(taskInputs[0], supplyInputs[0]);
    assert.deepEqual(taskInputs[0], {
      homeId: HOME,
      membershipId: MEMBERSHIP,
      endedAt: ENDED_AT,
      cause: 'VOLUNTARY_LEAVE',
    });
    assert.equal(taskInputs[0]?.endedAt, ENDED_AT);
    assert.equal(supplyInputs[0]?.endedAt, ENDED_AT);
    assert.deepEqual(membershipUpdates, [
      {
        membershipId: MEMBERSHIP,
        homeId: HOME,
        endedAt: ENDED_AT,
      },
    ]);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.eventType, 'membership.ended.v1');
    assert.equal(events[0]?.eventId, EVENT_ID);
    assert.equal(events[0]?.occurredAt, ENDED_AT);
    assert.equal(events[0]?.homeId, HOME);
    assert.deepEqual(events[0]?.payload, {
      membershipId: MEMBERSHIP,
      cause: 'VOLUNTARY_LEAVE',
    });
    assert.equal('userId' in (events[0]?.payload ?? {}), false);
  });

  void it('constructs membership.ended.v1 for each frozen cause', async () => {
    for (const cause of MEMBERSHIP_ENDED_CAUSES) {
      const { tx, endMembership, events } = commandOf({});
      await endMembership(tx, {
        homeId: HOME,
        membershipId: MEMBERSHIP,
        endedAt: ENDED_AT,
        cause,
      });
      assert.equal(events[0]?.payload.cause, cause);
    }
  });

  void it('does not call Supply, Membership, or outbox when Task cleanup fails', async () => {
    const { tx, endMembership, steps, membershipUpdates, events } = commandOf({
      taskError: new Error('injected task cleanup failure'),
    });

    await assert.rejects(
      () =>
        endMembership(tx, {
          homeId: HOME,
          membershipId: MEMBERSHIP,
          endedAt: ENDED_AT,
          cause: 'VOLUNTARY_LEAVE',
        }),
      /injected task cleanup failure/,
    );
    assert.deepEqual(steps, ['task']);
    assert.deepEqual(membershipUpdates, []);
    assert.deepEqual(events, []);
  });

  void it('does not update Membership or append outbox when Supply cleanup fails', async () => {
    const { tx, endMembership, steps, membershipUpdates, events } = commandOf({
      supplyError: new Error('injected supply cleanup failure'),
    });

    await assert.rejects(
      () =>
        endMembership(tx, {
          homeId: HOME,
          membershipId: MEMBERSHIP,
          endedAt: ENDED_AT,
          cause: 'ADMIN_REMOVAL',
        }),
      /injected supply cleanup failure/,
    );
    assert.deepEqual(steps, ['task', 'supply']);
    assert.deepEqual(membershipUpdates, []);
    assert.deepEqual(events, []);
  });

  void it('treats a post-lock zero-row UPDATE as structural integrity', async () => {
    const { tx, endMembership, steps, events } = commandOf({ updateRows: 0 });

    await assert.rejects(
      () =>
        endMembership(tx, {
          homeId: HOME,
          membershipId: MEMBERSHIP,
          endedAt: ENDED_AT,
          cause: 'HOME_ARCHIVED',
        }),
      StructuralIntegrityError,
    );
    assert.deepEqual(steps, ['task', 'supply', 'membership']);
    assert.deepEqual(events, []);
  });

  void it('does not append outbox when outbox append fails after a successful UPDATE', async () => {
    const { tx, endMembership, steps, membershipUpdates, events } = commandOf({
      outboxError: new Error('injected outbox failure'),
    });

    await assert.rejects(
      () =>
        endMembership(tx, {
          homeId: HOME,
          membershipId: MEMBERSHIP,
          endedAt: ENDED_AT,
          cause: 'VOLUNTARY_LEAVE',
        }),
      /injected outbox failure/,
    );
    assert.deepEqual(steps, ['task', 'supply', 'membership', 'outbox']);
    assert.deepEqual(membershipUpdates, [
      {
        membershipId: MEMBERSHIP,
        homeId: HOME,
        endedAt: ENDED_AT,
      },
    ]);
    assert.deepEqual(events, []);
  });

  void it('uses the supplied exact membershipId and never remaps another tenure', async () => {
    const { tx, endMembership, membershipUpdates, events } = commandOf({});

    const result = await endMembership(tx, {
      homeId: HOME,
      membershipId: MEMBERSHIP,
      endedAt: ENDED_AT,
      cause: 'VOLUNTARY_LEAVE',
    });

    assert.equal(result.membershipId, MEMBERSHIP);
    assert.equal(
      (membershipUpdates[0] as { membershipId: string }).membershipId,
      MEMBERSHIP,
    );
    assert.notEqual(result.membershipId, MEMBERSHIP_OLD);
    assert.equal(events[0]?.payload.membershipId, MEMBERSHIP);
  });

  void it('rejects an arbitrary cause before invoking ports', async () => {
    const { tx, endMembership, steps, events } = commandOf({});

    await assert.rejects(
      () =>
        endMembership(tx, {
          homeId: HOME,
          membershipId: MEMBERSHIP,
          endedAt: ENDED_AT,
          cause: 'because they left' as 'VOLUNTARY_LEAVE',
        }),
      /Invalid membership ended cause/,
    );
    assert.deepEqual(steps, []);
    assert.deepEqual(events, []);
  });
});
