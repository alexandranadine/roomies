import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ExactLockedMembership } from '../../domains/homes/lock-home-and-exact-memberships.js';
import { TaskAlreadyCompletedError } from '../../domains/tasks/errors.js';
import type { CompleteOpenTaskInstance } from '../../domains/tasks/repository.js';
import type { TaskInstance } from '../../domains/tasks/task.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  createCompleteTask,
  type CompleteTaskDependencies,
  type CompleteTaskInput,
} from './complete-task.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const MEMBERSHIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ASSIGNEE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OLD_MEMBERSHIP = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const TASK_A = '018f1e2c-7e3a-7000-8000-1234567890ab';
const TASK_B = '018f1e2c-7e3a-7000-8000-1234567890ac';
const CREATED_AT = new Date('2026-09-12T17:00:00.000Z');
const OCCURRED_AT = new Date('2026-09-12T18:00:00.000Z');
const PRIOR_COMPLETED_AT = new Date('2026-09-12T17:30:00.000Z');
const TX: TransactionContext = {
  query: () => Promise.reject(new Error('unexpected direct query')),
};

function actor(overrides: Partial<ActiveHomeActor> = {}): ActiveHomeActor {
  return {
    userId: USER,
    membershipId: MEMBERSHIP,
    homeId: HOME,
    role: 'ROOMMATE',
    ...overrides,
  };
}

function input(overrides: Partial<CompleteTaskInput> = {}): CompleteTaskInput {
  return {
    actor: actor(),
    homeId: HOME,
    taskId: TASK_A,
    ...overrides,
  };
}

function openTask(overrides: Partial<TaskInstance> = {}): TaskInstance {
  return Object.freeze({
    id: TASK_A,
    homeId: HOME,
    source: 'MANUAL',
    status: 'OPEN',
    title: 'Take out trash',
    scheduledFor: '2026-09-15',
    assignedMembershipId: ASSIGNEE,
    completedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  });
}

function completedFrom(
  locked: TaskInstance,
  write: CompleteOpenTaskInstance,
): TaskInstance {
  return Object.freeze({
    ...locked,
    status: 'COMPLETED',
    completedAt: write.completedAt,
    updatedAt: write.updatedAt,
  });
}

function lockedMembership(
  overrides: Partial<ExactLockedMembership> = {},
): ExactLockedMembership {
  return {
    id: MEMBERSHIP,
    userId: USER,
    homeId: HOME,
    role: 'ROOMMATE',
    endedAt: null,
    ...overrides,
  };
}

type HarnessOptions = {
  completeError?: Error;
  transactionError?: Error;
  lockError?: Error;
  homeArchived?: boolean;
  memberships?: readonly ExactLockedMembership[];
  lockedTask?: TaskInstance | null;
  completeResult?: TaskInstance | null;
};

function harness(options: HarnessOptions = {}) {
  const completes: CompleteOpenTaskInstance[] = [];
  const lockCalls: { homeId: string; membershipIds: readonly string[] }[] = [];
  const taskLocks: { homeId: string; taskId: string }[] = [];
  let committed = false;
  const lockedTask =
    options.lockedTask === undefined ? openTask() : options.lockedTask;

  const deps: CompleteTaskDependencies = {
    runTransaction: async (work) => {
      if (options.transactionError) {
        throw options.transactionError;
      }
      try {
        const result = await work(TX);
        committed = true;
        return result;
      } catch (error) {
        committed = false;
        throw error;
      }
    },
    lockHomeAndExactMemberships(_tx, lookup) {
      lockCalls.push({
        homeId: lookup.homeId,
        membershipIds: lookup.membershipIds,
      });
      if (options.lockError) {
        return Promise.reject(options.lockError);
      }
      return Promise.resolve({
        home: {
          id: lookup.homeId,
          archivedAt: options.homeArchived === true ? OCCURRED_AT : null,
        },
        memberships: options.memberships ?? [lockedMembership()],
      });
    },
    tasks: {
      lockByHomeAndId(_tx, homeId, taskId) {
        taskLocks.push({ homeId, taskId });
        return Promise.resolve(lockedTask);
      },
      completeOpenTask(_tx, write) {
        if (options.completeError) {
          return Promise.reject(options.completeError);
        }
        completes.push(write);
        if (options.completeResult !== undefined) {
          return Promise.resolve(options.completeResult);
        }
        if (lockedTask === null) {
          return Promise.resolve(null);
        }
        return Promise.resolve(completedFrom(lockedTask, write));
      },
    },
    clock: {
      now() {
        return OCCURRED_AT;
      },
    },
  };

  return {
    complete: createCompleteTask(deps),
    completes,
    lockCalls,
    taskLocks,
    isCommitted: () => committed,
  };
}

void describe('createCompleteTask', () => {
  void it('lets an active Roommate complete an OPEN manual Task', async () => {
    const { complete, completes, lockCalls, taskLocks } = harness();
    const result = await complete(input());
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.completedAt, OCCURRED_AT);
    assert.equal(result.updatedAt, OCCURRED_AT);
    assert.equal(result.title, 'Take out trash');
    assert.equal(result.source, 'MANUAL');
    assert.equal(result.scheduledFor, '2026-09-15');
    assert.equal(result.assignedMembershipId, ASSIGNEE);
    assert.equal(result.createdAt, CREATED_AT);
    assert.deepEqual(completes, [
      {
        homeId: HOME,
        taskId: TASK_A,
        completedAt: OCCURRED_AT,
        updatedAt: OCCURRED_AT,
      },
    ]);
    assert.deepEqual(lockCalls, [
      { homeId: HOME, membershipIds: [MEMBERSHIP] },
    ]);
    assert.deepEqual(taskLocks, [{ homeId: HOME, taskId: TASK_A }]);
  });

  void it('lets a Home Admin complete through the same ordinary capability', async () => {
    const { complete, completes } = harness({
      memberships: [lockedMembership({ role: 'ADMIN' })],
    });
    const result = await complete(input({ actor: actor({ role: 'ADMIN' }) }));
    assert.equal(result.status, 'COMPLETED');
    assert.equal(completes.length, 1);
  });

  void it('authorizes from the locked Membership role, not the request role', async () => {
    const { complete, completes } = harness({
      memberships: [lockedMembership({ role: 'ROOMMATE' })],
    });
    const result = await complete(input({ actor: actor({ role: 'ADMIN' }) }));
    assert.equal(result.status, 'COMPLETED');
    assert.equal(completes.length, 1);
  });

  void it('locks only the acting Membership, not the assignee', async () => {
    const { complete, lockCalls } = harness();
    await complete(input());
    assert.deepEqual(lockCalls, [
      { homeId: HOME, membershipIds: [MEMBERSHIP] },
    ]);
    assert.equal(lockCalls[0]?.membershipIds.includes(ASSIGNEE), false);
  });

  void it('preserves title, source, scheduledFor, and assignment', async () => {
    const { complete } = harness({
      lockedTask: openTask({
        title: 'Café 家  chore',
        source: 'RECURRING',
        scheduledFor: null,
        assignedMembershipId: null,
      }),
    });
    const result = await complete(input());
    assert.equal(result.title, 'Café 家  chore');
    assert.equal(result.source, 'RECURRING');
    assert.equal(result.scheduledFor, null);
    assert.equal(result.assignedMembershipId, null);
  });

  void it('sets completedAt and updatedAt from the injected Clock', async () => {
    const { complete, completes } = harness();
    const result = await complete(input());
    assert.equal(result.completedAt?.getTime(), OCCURRED_AT.getTime());
    assert.equal(result.updatedAt.getTime(), OCCURRED_AT.getTime());
    assert.equal(completes[0]?.completedAt, OCCURRED_AT);
    assert.equal(completes[0]?.updatedAt, OCCURRED_AT);
  });

  void it('rejects an already COMPLETED Task without writing again', async () => {
    const { complete, completes, isCommitted } = harness({
      lockedTask: openTask({
        status: 'COMPLETED',
        completedAt: PRIOR_COMPLETED_AT,
        updatedAt: PRIOR_COMPLETED_AT,
      }),
    });
    await assert.rejects(() => complete(input()), TaskAlreadyCompletedError);
    assert.deepEqual(completes, []);
    assert.equal(isCommitted(), false);
  });

  void it('maps a defensive zero-row complete to the same state conflict', async () => {
    const { complete, isCommitted } = harness({
      completeResult: null,
    });
    await assert.rejects(() => complete(input()), TaskAlreadyCompletedError);
    assert.equal(isCommitted(), false);
  });

  void it('conceals an unknown Task without writing', async () => {
    const { complete, completes, isCommitted } = harness({
      lockedTask: null,
    });
    await assert.rejects(() => complete(input()), ConcealedNotFoundError);
    assert.deepEqual(completes, []);
    assert.equal(isCommitted(), false);
  });

  void it('conceals a Task locked under another Home id as missing', async () => {
    const { complete, completes } = harness({
      lockedTask: null,
    });
    await assert.rejects(
      () => complete(input({ taskId: TASK_B })),
      ConcealedNotFoundError,
    );
    assert.deepEqual(completes, []);
  });

  void it('rejects a stale or ended actor without completing', async () => {
    const ended = harness({
      memberships: [lockedMembership({ endedAt: OCCURRED_AT })],
    });
    const missing = harness({ memberships: [] });

    await assert.rejects(() => ended.complete(input()), ConcealedNotFoundError);
    await assert.rejects(
      () => missing.complete(input()),
      ConcealedNotFoundError,
    );
    assert.equal(ended.isCommitted(), false);
    assert.equal(missing.isCommitted(), false);
    assert.deepEqual(ended.completes, []);
    assert.deepEqual(missing.completes, []);
  });

  void it('does not let an old tenure inherit authority after rejoin', async () => {
    const { complete, completes } = harness({
      memberships: [
        lockedMembership({
          id: OLD_MEMBERSHIP,
          endedAt: OCCURRED_AT,
        }),
        lockedMembership({
          id: MEMBERSHIP,
          role: 'ROOMMATE',
        }),
      ],
    });
    await assert.rejects(
      () =>
        complete(
          input({
            actor: actor({ membershipId: OLD_MEMBERSHIP }),
          }),
        ),
      ConcealedNotFoundError,
    );
    assert.deepEqual(completes, []);
  });

  void it('rejects an actor whose userId no longer matches the locked tenure', async () => {
    const { complete, completes } = harness({
      memberships: [lockedMembership({ userId: OTHER_USER })],
    });
    await assert.rejects(() => complete(input()), ConcealedNotFoundError);
    assert.deepEqual(completes, []);
  });

  void it('conceals an archived Home observed inside the protected transaction', async () => {
    const { complete, completes, taskLocks } = harness({ homeArchived: true });
    await assert.rejects(() => complete(input()), ConcealedNotFoundError);
    assert.deepEqual(completes, []);
    assert.deepEqual(taskLocks, []);
  });

  void it('conceals a Home-scope mismatch without locking', async () => {
    const { complete, completes, lockCalls, taskLocks } = harness();
    await assert.rejects(
      () => complete(input({ homeId: OTHER_HOME })),
      ConcealedNotFoundError,
    );
    assert.deepEqual(completes, []);
    assert.deepEqual(lockCalls, []);
    assert.deepEqual(taskLocks, []);
  });

  void it('leaves the Task OPEN when the complete write fails', async () => {
    const { complete, isCommitted } = harness({
      completeError: new Error('complete failed'),
    });
    await assert.rejects(() => complete(input()), /complete failed/);
    assert.equal(isCommitted(), false);
  });

  void it('leaves the Task OPEN when protected revalidation fails', async () => {
    const { complete, completes, isCommitted } = harness({
      lockError: new ConcealedNotFoundError(),
    });
    await assert.rejects(() => complete(input()), ConcealedNotFoundError);
    assert.equal(isCommitted(), false);
    assert.deepEqual(completes, []);
  });
});
