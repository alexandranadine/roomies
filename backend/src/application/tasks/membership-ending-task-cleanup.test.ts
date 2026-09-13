import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { UnassignMembershipAssignments } from '../../domains/tasks/repository.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  createMembershipEndingTaskCleanup,
  type MembershipEndingTaskCleanupTasks,
} from './membership-ending-task-cleanup.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBERSHIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_MEMBERSHIP = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const REJOINED_MEMBERSHIP = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ENDED_AT = new Date('2026-03-15T12:34:56.789Z');
const CREATED_AT = new Date('2026-03-01T00:00:00.000Z');
const TX: TransactionContext = {
  query: () => Promise.reject(new Error('cleanup must use repository methods')),
};

type InstanceRow = {
  id: string;
  homeId: string;
  source: 'MANUAL' | 'RECURRING';
  status: 'OPEN' | 'COMPLETED';
  assignedMembershipId: string | null;
  updatedAt: Date;
};

type DefinitionRow = {
  id: string;
  homeId: string;
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  assignedMembershipId: string | null;
  creatorMembershipId: string;
  deactivatedAt: Date | null;
  updatedAt: Date;
};

function instance(
  overrides: Partial<InstanceRow> & Pick<InstanceRow, 'id'>,
): InstanceRow {
  return {
    homeId: HOME,
    source: 'MANUAL',
    status: 'OPEN',
    assignedMembershipId: MEMBERSHIP,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function definition(
  overrides: Partial<DefinitionRow> & Pick<DefinitionRow, 'id'>,
): DefinitionRow {
  return {
    homeId: HOME,
    frequency: 'DAILY',
    assignedMembershipId: MEMBERSHIP,
    creatorMembershipId: OTHER_MEMBERSHIP,
    deactivatedAt: null,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function storeOf(input: {
  instances?: InstanceRow[];
  definitions?: DefinitionRow[];
}) {
  const instances = input.instances ?? [];
  const definitions = input.definitions ?? [];
  const calls: UnassignMembershipAssignments[] = [];
  const tasks: MembershipEndingTaskCleanupTasks = {
    unassignOpenTasksForMembership(_tx, assignment) {
      calls.push(assignment);
      let updated = 0;
      for (const row of instances) {
        if (
          row.homeId === assignment.homeId &&
          row.assignedMembershipId === assignment.membershipId &&
          row.status === 'OPEN'
        ) {
          row.assignedMembershipId = null;
          row.updatedAt = assignment.updatedAt;
          updated += 1;
        }
      }
      return Promise.resolve(updated);
    },
    unassignActiveDefinitionsForMembership(_tx, assignment) {
      calls.push(assignment);
      let updated = 0;
      for (const row of definitions) {
        if (
          row.homeId === assignment.homeId &&
          row.assignedMembershipId === assignment.membershipId &&
          row.deactivatedAt === null
        ) {
          row.assignedMembershipId = null;
          row.updatedAt = assignment.updatedAt;
          updated += 1;
        }
      }
      return Promise.resolve(updated);
    },
  };
  return {
    instances,
    definitions,
    calls,
    cleanup: createMembershipEndingTaskCleanup(tasks),
  };
}

async function endExactTenure(
  store: ReturnType<typeof storeOf>,
): Promise<void> {
  await store.cleanup.handleMembershipEnded(TX, {
    homeId: HOME,
    membershipId: MEMBERSHIP,
    endedAt: ENDED_AT,
    cause: 'VOLUNTARY_LEAVE',
  });
}

void describe('membership-ending Task cleanup application seam', () => {
  void it('ending Membership with no Task assignments succeeds', async () => {
    const store = storeOf({});
    await endExactTenure(store);
    assert.equal(store.calls.length, 2);
    assert.deepEqual(store.calls[0], {
      homeId: HOME,
      membershipId: MEMBERSHIP,
      updatedAt: ENDED_AT,
    });
    assert.deepEqual(store.calls[1], store.calls[0]);
  });

  void it('clears an OPEN manual Task assignment', async () => {
    const store = storeOf({
      instances: [instance({ id: 'open-manual' })],
    });
    await endExactTenure(store);
    assert.equal(store.instances[0]?.assignedMembershipId, null);
    assert.equal(store.instances[0]?.updatedAt, ENDED_AT);
    assert.equal(store.instances[0]?.status, 'OPEN');
  });

  void it('clears an OPEN recurring TaskInstance assignment', async () => {
    const store = storeOf({
      instances: [instance({ id: 'open-recurring', source: 'RECURRING' })],
    });
    await endExactTenure(store);
    assert.equal(store.instances[0]?.assignedMembershipId, null);
    assert.equal(store.instances[0]?.source, 'RECURRING');
  });

  void it('preserves COMPLETED manual Task historical assignment', async () => {
    const store = storeOf({
      instances: [instance({ id: 'completed-manual', status: 'COMPLETED' })],
    });
    await endExactTenure(store);
    assert.equal(store.instances[0]?.assignedMembershipId, MEMBERSHIP);
    assert.equal(store.instances[0]?.updatedAt, CREATED_AT);
  });

  void it('preserves COMPLETED recurring Task historical assignment', async () => {
    const store = storeOf({
      instances: [
        instance({
          id: 'completed-recurring',
          source: 'RECURRING',
          status: 'COMPLETED',
        }),
      ],
    });
    await endExactTenure(store);
    assert.equal(store.instances[0]?.assignedMembershipId, MEMBERSHIP);
  });

  void it('clears an active DAILY definition assignment', async () => {
    const store = storeOf({
      definitions: [definition({ id: 'daily', frequency: 'DAILY' })],
    });
    await endExactTenure(store);
    assert.equal(store.definitions[0]?.assignedMembershipId, null);
    assert.equal(store.definitions[0]?.updatedAt, ENDED_AT);
    assert.equal(store.definitions[0]?.creatorMembershipId, OTHER_MEMBERSHIP);
  });

  void it('clears an active WEEKLY definition assignment', async () => {
    const store = storeOf({
      definitions: [definition({ id: 'weekly', frequency: 'WEEKLY' })],
    });
    await endExactTenure(store);
    assert.equal(store.definitions[0]?.assignedMembershipId, null);
    assert.equal(store.definitions[0]?.frequency, 'WEEKLY');
  });

  void it('clears an active MONTHLY definition assignment', async () => {
    const store = storeOf({
      definitions: [definition({ id: 'monthly', frequency: 'MONTHLY' })],
    });
    await endExactTenure(store);
    assert.equal(store.definitions[0]?.assignedMembershipId, null);
    assert.equal(store.definitions[0]?.frequency, 'MONTHLY');
  });

  void it('preserves a deactivated definition assignment', async () => {
    const store = storeOf({
      definitions: [
        definition({
          id: 'inactive',
          deactivatedAt: CREATED_AT,
        }),
      ],
    });
    await endExactTenure(store);
    assert.equal(store.definitions[0]?.assignedMembershipId, MEMBERSHIP);
    assert.equal(store.definitions[0]?.updatedAt, CREATED_AT);
  });

  void it('preserves creatorMembershipId when the creator ends', async () => {
    const store = storeOf({
      definitions: [
        definition({
          id: 'created-by-ending',
          assignedMembershipId: OTHER_MEMBERSHIP,
          creatorMembershipId: MEMBERSHIP,
        }),
      ],
    });
    await endExactTenure(store);
    assert.equal(store.definitions[0]?.creatorMembershipId, MEMBERSHIP);
    assert.equal(store.definitions[0]?.assignedMembershipId, OTHER_MEMBERSHIP);
  });

  void it('preserves creatorMembershipId when creator equals assignee', async () => {
    const store = storeOf({
      definitions: [
        definition({
          id: 'self-assigned',
          assignedMembershipId: MEMBERSHIP,
          creatorMembershipId: MEMBERSHIP,
        }),
      ],
    });
    await endExactTenure(store);
    assert.equal(store.definitions[0]?.creatorMembershipId, MEMBERSHIP);
    assert.equal(store.definitions[0]?.assignedMembershipId, null);
  });

  void it('leaves a Task assigned to a different Membership unchanged', async () => {
    const store = storeOf({
      instances: [
        instance({
          id: 'other-tenure',
          assignedMembershipId: OTHER_MEMBERSHIP,
        }),
      ],
    });
    await endExactTenure(store);
    assert.equal(store.instances[0]?.assignedMembershipId, OTHER_MEMBERSHIP);
  });

  void it('enforces exact Home scope', async () => {
    const store = storeOf({
      instances: [instance({ id: 'other-home', homeId: OTHER_HOME })],
      definitions: [definition({ id: 'other-home-def', homeId: OTHER_HOME })],
    });
    await endExactTenure(store);
    assert.equal(store.instances[0]?.assignedMembershipId, MEMBERSHIP);
    assert.equal(store.definitions[0]?.assignedMembershipId, MEMBERSHIP);
  });

  void it('enforces exact Membership tenure', async () => {
    const store = storeOf({
      instances: [
        instance({
          id: 'other-id',
          assignedMembershipId: OTHER_MEMBERSHIP,
        }),
      ],
    });
    await endExactTenure(store);
    assert.equal(store.instances[0]?.assignedMembershipId, OTHER_MEMBERSHIP);
    assert.notEqual(store.calls[0]?.membershipId, OTHER_MEMBERSHIP);
  });

  void it('does not affect new rejoined tenure assignments when the old tenure ends', async () => {
    const store = storeOf({
      instances: [
        instance({
          id: 'old-open',
          assignedMembershipId: MEMBERSHIP,
        }),
        instance({
          id: 'rejoined-open',
          assignedMembershipId: REJOINED_MEMBERSHIP,
        }),
      ],
      definitions: [
        definition({
          id: 'rejoined-def',
          assignedMembershipId: REJOINED_MEMBERSHIP,
        }),
      ],
    });
    await endExactTenure(store);
    assert.equal(store.instances[0]?.assignedMembershipId, null);
    assert.equal(store.instances[1]?.assignedMembershipId, REJOINED_MEMBERSHIP);
    assert.equal(
      store.definitions[0]?.assignedMembershipId,
      REJOINED_MEMBERSHIP,
    );
  });

  void it('uses the supplied shared operation timestamp', async () => {
    const store = storeOf({
      instances: [instance({ id: 'stamp-instance' })],
      definitions: [definition({ id: 'stamp-definition' })],
    });
    await endExactTenure(store);
    assert.equal(store.instances[0]?.updatedAt, ENDED_AT);
    assert.equal(store.definitions[0]?.updatedAt, ENDED_AT);
    assert.equal(store.calls[0]?.updatedAt, ENDED_AT);
    assert.equal(store.calls[1]?.updatedAt, ENDED_AT);
  });

  void it('does not emit a Task event', async () => {
    const source = await readFile(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        'membership-ending-task-cleanup.ts',
      ),
      'utf8',
    );
    assert.doesNotMatch(source, /outbox/);
    assert.doesNotMatch(source, /task\.unassigned/);
    assert.doesNotMatch(source, /task\.assignment_changed/);
    assert.doesNotMatch(source, /task\.definition_updated/);
    const store = storeOf({
      instances: [instance({ id: 'no-event' })],
    });
    await endExactTenure(store);
    assert.equal(store.calls.length, 2);
  });
});
