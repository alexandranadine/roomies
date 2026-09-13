import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ExactLockedMembership } from '../../domains/homes/lock-home-and-exact-memberships.js';
import { TaskDefinitionAlreadyDeactivatedError } from '../../domains/tasks/errors.js';
import { parseHomeLocalDate } from '../../domains/tasks/home-local-date.js';
import type { DeactivateActiveTaskDefinition } from '../../domains/tasks/repository.js';
import type { TaskDefinition } from '../../domains/tasks/task-definition.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  createDeactivateTaskDefinition,
  type DeactivateTaskDefinitionDependencies,
  type DeactivateTaskDefinitionInput,
} from './deactivate-task-definition.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';
const MEMBERSHIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_MEMBERSHIP = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DEFINITION_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const OCCURRED_AT = new Date('2026-09-13T18:00:00.000Z');
const CREATED_AT = new Date('2026-09-12T18:00:00.000Z');
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
  overrides: Partial<DeactivateTaskDefinitionInput> = {},
): DeactivateTaskDefinitionInput {
  return {
    actor: actor(),
    homeId: HOME,
    taskDefinitionId: DEFINITION_ID,
    ...overrides,
  };
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

function activeDefinition(
  overrides: Partial<TaskDefinition> = {},
): TaskDefinition {
  return {
    id: DEFINITION_ID,
    homeId: HOME,
    title: 'Weekly trash',
    frequency: 'WEEKLY',
    weekday: 1,
    dayOfMonth: null,
    assignedMembershipId: OTHER_MEMBERSHIP,
    creatorMembershipId: MEMBERSHIP,
    nextOccurrenceDate: parseHomeLocalDate('2026-09-14'),
    nextOccurrenceAt: new Date('2026-09-14T00:00:00.000Z'),
    deactivatedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

type HarnessOptions = {
  definition?: TaskDefinition | null;
  deactivateResult?: TaskDefinition | null;
  homeArchived?: boolean;
  memberships?: readonly ExactLockedMembership[];
  actorRole?: ActiveHomeActor['role'];
};

function harness(options: HarnessOptions = {}) {
  const locks: { homeId: string; taskDefinitionId: string }[] = [];
  const writes: DeactivateActiveTaskDefinition[] = [];
  let committed = false;
  const locked =
    options.definition === undefined ? activeDefinition() : options.definition;

  const deps: DeactivateTaskDefinitionDependencies = {
    runTransaction: async (work) => {
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
      return Promise.resolve({
        home: {
          id: lookup.homeId,
          archivedAt: options.homeArchived === true ? OCCURRED_AT : null,
          timezone: 'UTC',
        },
        memberships: options.memberships ?? [
          lockedMembership({
            role: options.actorRole ?? 'ROOMMATE',
          }),
        ],
      });
    },
    tasks: {
      lockDefinitionByHomeAndId(_tx, homeId, taskDefinitionId) {
        locks.push({ homeId, taskDefinitionId });
        return Promise.resolve(locked);
      },
      deactivateActiveDefinition(_tx, write) {
        writes.push(write);
        if (options.deactivateResult === null) {
          return Promise.resolve(null);
        }
        return Promise.resolve(
          options.deactivateResult ??
            activeDefinition({
              deactivatedAt: write.deactivatedAt,
              nextOccurrenceDate: null,
              nextOccurrenceAt: null,
              updatedAt: write.deactivatedAt,
            }),
        );
      },
    },
    clock: {
      now() {
        return OCCURRED_AT;
      },
    },
  };

  return {
    deactivate: createDeactivateTaskDefinition(deps),
    locks,
    writes,
    isCommitted: () => committed,
  };
}

void describe('createDeactivateTaskDefinition', () => {
  void it('lets the exact creator Roommate deactivate', async () => {
    const { deactivate, writes, locks } = harness();
    const result = await deactivate(input());
    assert.equal(
      result.deactivatedAt?.toISOString(),
      OCCURRED_AT.toISOString(),
    );
    assert.equal(result.updatedAt.toISOString(), OCCURRED_AT.toISOString());
    assert.equal(result.nextOccurrenceDate, null);
    assert.equal(result.nextOccurrenceAt, null);
    assert.deepEqual(locks, [
      { homeId: HOME, taskDefinitionId: DEFINITION_ID },
    ]);
    assert.deepEqual(writes, [
      {
        homeId: HOME,
        taskDefinitionId: DEFINITION_ID,
        deactivatedAt: OCCURRED_AT,
      },
    ]);
  });

  void it('lets a non-creator Admin deactivate through locked Admin authority', async () => {
    const { deactivate } = harness({
      definition: activeDefinition({ creatorMembershipId: OTHER_MEMBERSHIP }),
      actorRole: 'ADMIN',
      memberships: [lockedMembership({ role: 'ADMIN' })],
    });
    const result = await deactivate(input({ actor: actor({ role: 'ADMIN' }) }));
    assert.equal(
      result.deactivatedAt?.toISOString(),
      OCCURRED_AT.toISOString(),
    );
  });

  void it('denies a non-creator Roommate and an assignee-only actor', async () => {
    const nonCreator = harness({
      definition: activeDefinition({ creatorMembershipId: OTHER_MEMBERSHIP }),
      memberships: [lockedMembership({ role: 'ROOMMATE' })],
    });
    await assert.rejects(
      () => nonCreator.deactivate(input()),
      ConcealedNotFoundError,
    );
    assert.deepEqual(nonCreator.writes, []);

    const assigneeOnly = harness({
      definition: activeDefinition({
        creatorMembershipId: OTHER_MEMBERSHIP,
        assignedMembershipId: MEMBERSHIP,
      }),
    });
    await assert.rejects(
      () => assigneeOnly.deactivate(input()),
      ConcealedNotFoundError,
    );
  });

  void it('conceals unknown and cross-Home definitions', async () => {
    const missing = harness({ definition: null });
    await assert.rejects(
      () => missing.deactivate(input()),
      ConcealedNotFoundError,
    );
    assert.deepEqual(missing.writes, []);
  });

  void it('conceals an archived Home and an ended actor', async () => {
    const archived = harness({ homeArchived: true });
    await assert.rejects(
      () => archived.deactivate(input()),
      ConcealedNotFoundError,
    );

    const ended = harness({
      memberships: [lockedMembership({ endedAt: OCCURRED_AT })],
    });
    await assert.rejects(
      () => ended.deactivate(input()),
      ConcealedNotFoundError,
    );
  });

  void it('ignores a stale request Admin role when the locked role is Roommate', async () => {
    const { deactivate, writes } = harness({
      definition: activeDefinition({ creatorMembershipId: OTHER_MEMBERSHIP }),
      memberships: [lockedMembership({ role: 'ROOMMATE' })],
    });
    await assert.rejects(
      () => deactivate(input({ actor: actor({ role: 'ADMIN' }) })),
      ConcealedNotFoundError,
    );
    assert.deepEqual(writes, []);
  });

  void it('conflicts when the locked definition is already deactivated', async () => {
    const { deactivate, writes } = harness({
      definition: activeDefinition({
        deactivatedAt: CREATED_AT,
        nextOccurrenceDate: null,
        nextOccurrenceAt: null,
      }),
    });
    await assert.rejects(
      () => deactivate(input()),
      TaskDefinitionAlreadyDeactivatedError,
    );
    assert.deepEqual(writes, []);
  });

  void it('conflicts when the defensive update matches zero active rows', async () => {
    const { deactivate } = harness({ deactivateResult: null });
    await assert.rejects(
      () => deactivate(input()),
      TaskDefinitionAlreadyDeactivatedError,
    );
  });
});
