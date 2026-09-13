import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ExactLockedMembership } from '../../domains/homes/lock-home-and-exact-memberships.js';
import type { NewManualTaskInstance } from '../../domains/tasks/repository.js';
import type { TaskInstance } from '../../domains/tasks/task.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  InvalidRequestError,
} from '../../platform/authz/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  createCreateManualTask,
  type CreateManualTaskDependencies,
  type CreateManualTaskInput,
} from './create-manual-task.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const MEMBERSHIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ASSIGNEE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OLD_MEMBERSHIP = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const TASK_A = '018f1e2c-7e3a-7000-8000-1234567890ab';
const TASK_B = '018f1e2c-7e3a-7000-8000-1234567890ac';
const OCCURRED_AT = new Date('2026-09-12T18:00:00.000Z');
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

function input(
  overrides: Partial<CreateManualTaskInput> = {},
): CreateManualTaskInput {
  return {
    actor: actor(),
    homeId: HOME,
    title: 'Take out trash',
    ...overrides,
  };
}

function persisted(task: NewManualTaskInstance): TaskInstance {
  return Object.freeze({
    id: task.id,
    homeId: task.homeId,
    source: 'MANUAL',
    status: 'OPEN',
    title: task.title,
    scheduledFor: task.scheduledFor,
    assignedMembershipId: task.assignedMembershipId,
    completedAt: null,
    createdAt: task.createdAt,
    updatedAt: task.createdAt,
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
  insertError?: Error;
  transactionError?: Error;
  lockError?: Error;
  homeArchived?: boolean;
  memberships?: readonly ExactLockedMembership[];
  ids?: string[];
};

function harness(options: HarnessOptions = {}) {
  const inserts: NewManualTaskInstance[] = [];
  const lockCalls: { homeId: string; membershipIds: readonly string[] }[] = [];
  let committed = false;
  let idIndex = 0;
  const ids = options.ids ?? [TASK_A];

  const deps: CreateManualTaskDependencies = {
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
          timezone: 'UTC',
        },
        memberships: options.memberships ?? [
          lockedMembership(),
          ...(lookup.membershipIds.includes(ASSIGNEE)
            ? [
                lockedMembership({
                  id: ASSIGNEE,
                  userId: OTHER_USER,
                }),
              ]
            : []),
        ],
      });
    },
    tasks: {
      insertManual(_tx, task) {
        if (options.insertError) {
          return Promise.reject(options.insertError);
        }
        inserts.push(task);
        return Promise.resolve(persisted(task));
      },
    },
    clock: {
      now() {
        return OCCURRED_AT;
      },
    },
    ids: {
      next() {
        const id = ids[idIndex];
        idIndex += 1;
        if (id === undefined) {
          throw new Error('unexpected extra id');
        }
        return id;
      },
    },
  };

  return {
    create: createCreateManualTask(deps),
    inserts,
    lockCalls,
    isCommitted: () => committed,
  };
}

void describe('createCreateManualTask', () => {
  void it('lets an active Roommate create an undated unassigned manual Task', async () => {
    const { create, inserts, lockCalls } = harness();
    const created = await create(input());
    assert.equal(created.source, 'MANUAL');
    assert.equal(created.status, 'OPEN');
    assert.equal(created.completedAt, null);
    assert.equal(created.scheduledFor, null);
    assert.equal(created.assignedMembershipId, null);
    assert.equal(created.title, 'Take out trash');
    assert.equal(created.id, TASK_A);
    const inserted = inserts[0];
    assert.ok(inserted);
    assert.deepEqual(inserted, {
      id: TASK_A,
      homeId: HOME,
      title: 'Take out trash',
      scheduledFor: null,
      assignedMembershipId: null,
      createdAt: OCCURRED_AT,
    });
    assert.equal('source' in inserted, false);
    assert.equal('status' in inserted, false);
    assert.equal('taskDefinitionId' in inserted, false);
    assert.equal('completedAt' in inserted, false);
    assert.deepEqual(lockCalls, [
      { homeId: HOME, membershipIds: [MEMBERSHIP] },
    ]);
  });

  void it('lets an active Roommate create a dated manual Task', async () => {
    const { create } = harness();
    const created = await create(input({ scheduledFor: '2026-09-15' }));
    assert.equal(created.scheduledFor, '2026-09-15');
  });

  void it('lets an active Roommate assign an exact same-Home Membership', async () => {
    const { create, lockCalls } = harness();
    const created = await create(input({ assignedMembershipId: ASSIGNEE }));
    assert.equal(created.assignedMembershipId, ASSIGNEE);
    assert.deepEqual(lockCalls, [
      { homeId: HOME, membershipIds: [MEMBERSHIP, ASSIGNEE] },
    ]);
  });

  void it('lets a Home Admin create through the same content path', async () => {
    const { create, inserts } = harness({
      memberships: [lockedMembership({ role: 'ADMIN' })],
    });
    const created = await create(input({ actor: actor({ role: 'ADMIN' }) }));
    assert.equal(created.title, 'Take out trash');
    assert.equal(inserts.length, 1);
  });

  void it('authorizes from the locked Membership role, not the request role', async () => {
    const { create, inserts } = harness({
      memberships: [lockedMembership({ role: 'ROOMMATE' })],
    });
    const created = await create(input({ actor: actor({ role: 'ADMIN' }) }));
    assert.equal(created.title, 'Take out trash');
    assert.equal(inserts.length, 1);
  });

  void it('locks actor and assignee once when they are the same Membership', async () => {
    const { create, lockCalls } = harness();
    const created = await create(input({ assignedMembershipId: MEMBERSHIP }));
    assert.equal(created.assignedMembershipId, MEMBERSHIP);
    assert.deepEqual(lockCalls, [
      { homeId: HOME, membershipIds: [MEMBERSHIP] },
    ]);
  });

  void it('revalidates the exact actor Membership inside the mutation', async () => {
    const { create, inserts } = harness({
      memberships: [
        lockedMembership({
          id: MEMBERSHIP,
          userId: USER,
          homeId: HOME,
          role: 'ROOMMATE',
          endedAt: null,
        }),
      ],
    });
    await create(input());
    assert.equal(inserts.length, 1);
  });

  void it('rejects a stale or ended actor without inserting', async () => {
    const ended = harness({
      memberships: [lockedMembership({ endedAt: OCCURRED_AT })],
    });
    const missing = harness({ memberships: [], ids: [TASK_B] });

    await assert.rejects(() => ended.create(input()), ConcealedNotFoundError);
    await assert.rejects(() => missing.create(input()), ConcealedNotFoundError);
    assert.equal(ended.isCommitted(), false);
    assert.equal(missing.isCommitted(), false);
    assert.deepEqual(ended.inserts, []);
    assert.deepEqual(missing.inserts, []);
  });

  void it('does not let an old tenure inherit authority after rejoin', async () => {
    const { create, inserts } = harness({
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
        create(
          input({
            actor: actor({ membershipId: OLD_MEMBERSHIP }),
          }),
        ),
      ConcealedNotFoundError,
    );
    assert.deepEqual(inserts, []);
  });

  void it('rejects an actor whose userId no longer matches the locked tenure', async () => {
    const { create, inserts } = harness({
      memberships: [lockedMembership({ userId: OTHER_USER })],
    });
    await assert.rejects(() => create(input()), ConcealedNotFoundError);
    assert.deepEqual(inserts, []);
  });

  void it('conceals an archived Home observed inside the protected transaction', async () => {
    const { create, inserts } = harness({ homeArchived: true });
    await assert.rejects(() => create(input()), ConcealedNotFoundError);
    assert.deepEqual(inserts, []);
  });

  void it('trims title ends and preserves Unicode and internal whitespace', async () => {
    const { create } = harness();
    const created = await create(input({ title: '  Café 家  chore  ' }));
    assert.equal(created.title, 'Café 家  chore');
  });

  void it('rejects whitespace-only titles before persistence', async () => {
    const { create, inserts, lockCalls } = harness();
    await assert.rejects(
      () => create(input({ title: '   ' })),
      InvalidRequestError,
    );
    assert.deepEqual(inserts, []);
    assert.deepEqual(lockCalls, []);
  });

  void it('rejects invalid calendar dates and timestamps', async () => {
    const { create, inserts } = harness();
    await assert.rejects(
      () => create(input({ scheduledFor: '2026-02-30' })),
      InvalidRequestError,
    );
    await assert.rejects(
      () => create(input({ scheduledFor: '2026-09-15T00:00:00Z' })),
      InvalidRequestError,
    );
    assert.deepEqual(inserts, []);
  });

  void it('persists omitted and explicit null scheduledFor as null', async () => {
    const omitted = harness();
    const explicit = harness({ ids: [TASK_B] });
    assert.equal((await omitted.create(input())).scheduledFor, null);
    assert.equal(
      (await explicit.create(input({ scheduledFor: null }))).scheduledFor,
      null,
    );
  });

  void it('rejects ended, cross-Home, and unknown assignees the same way', async () => {
    const ended = harness({
      memberships: [
        lockedMembership(),
        lockedMembership({
          id: ASSIGNEE,
          userId: OTHER_USER,
          endedAt: OCCURRED_AT,
        }),
      ],
    });
    const crossHome = harness({
      memberships: [
        lockedMembership(),
        lockedMembership({
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          userId: OTHER_USER,
          homeId: OTHER_HOME,
        }),
      ],
      ids: [TASK_B],
    });
    const unknown = harness({
      memberships: [lockedMembership()],
      ids: [TASK_A],
    });

    await assert.rejects(
      () => ended.create(input({ assignedMembershipId: ASSIGNEE })),
      InvalidRequestError,
    );
    await assert.rejects(
      () =>
        crossHome.create(
          input({
            assignedMembershipId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          }),
        ),
      InvalidRequestError,
    );
    await assert.rejects(
      () =>
        unknown.create(
          input({
            assignedMembershipId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          }),
        ),
      InvalidRequestError,
    );
    assert.equal(ended.isCommitted(), false);
    assert.equal(crossHome.isCommitted(), false);
    assert.equal(unknown.isCommitted(), false);
    assert.deepEqual(ended.inserts, []);
  });

  void it('rejects User.id format only when it is not a Membership tenure', async () => {
    const { create, lockCalls } = harness({
      memberships: [lockedMembership()],
    });
    await assert.rejects(
      () => create(input({ assignedMembershipId: USER })),
      InvalidRequestError,
    );
    assert.deepEqual(lockCalls, [
      { homeId: HOME, membershipIds: [MEMBERSHIP, USER] },
    ]);
  });

  void it('rejects a malformed assignee without looking up tenure', async () => {
    const { create, lockCalls, inserts } = harness();
    await assert.rejects(
      () => create(input({ assignedMembershipId: 'not-a-uuid' })),
      InvalidRequestError,
    );
    assert.deepEqual(lockCalls, []);
    assert.deepEqual(inserts, []);
  });

  void it('conceals a Home-scope mismatch without inserting', async () => {
    const { create, inserts, lockCalls } = harness();
    await assert.rejects(
      () => create(input({ homeId: OTHER_HOME })),
      ConcealedNotFoundError,
    );
    assert.deepEqual(inserts, []);
    assert.deepEqual(lockCalls, []);
  });

  void it('allows independent same-title Tasks with distinct generated IDs', async () => {
    const { create, inserts } = harness({ ids: [TASK_A, TASK_B] });
    const first = await create(input({ title: 'Same title' }));
    const second = await create(input({ title: 'Same title' }));
    assert.equal(first.title, 'Same title');
    assert.equal(second.title, 'Same title');
    assert.equal(first.id, TASK_A);
    assert.equal(second.id, TASK_B);
    assert.notEqual(first.id, second.id);
    assert.equal(inserts.length, 2);
  });

  void it('leaves no partial row when insert fails', async () => {
    const { create, isCommitted } = harness({
      insertError: new Error('insert failed'),
    });
    await assert.rejects(() => create(input()), /insert failed/);
    assert.equal(isCommitted(), false);
  });

  void it('leaves no Task when protected revalidation fails', async () => {
    const { create, inserts, isCommitted } = harness({
      lockError: new ConcealedNotFoundError(),
    });
    await assert.rejects(() => create(input()), ConcealedNotFoundError);
    assert.equal(isCommitted(), false);
    assert.deepEqual(inserts, []);
  });
});
