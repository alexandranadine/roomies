import { Temporal } from '@js-temporal/polyfill';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ExactLockedMembership } from '../../domains/homes/lock-home-and-exact-memberships.js';
import type { NewTaskDefinition } from '../../domains/tasks/repository.js';
import { computeInitialRecurrenceCursor } from '../../domains/tasks/recurrence-cursor.js';
import type { TaskDefinition } from '../../domains/tasks/task-definition.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  InvalidRequestError,
} from '../../platform/authz/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  createCreateRecurringTaskDefinition,
  type CreateRecurringTaskDefinitionDependencies,
  type CreateRecurringTaskDefinitionInput,
} from './create-recurring-task-definition.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const MEMBERSHIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ASSIGNEE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OLD_MEMBERSHIP = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const DEFINITION_A = '018f1e2c-7e3a-7000-8000-1234567890ab';
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
  overrides: Partial<CreateRecurringTaskDefinitionInput> = {},
): CreateRecurringTaskDefinitionInput {
  return {
    actor: actor(),
    homeId: HOME,
    title: 'Take out trash',
    frequency: 'DAILY',
    ...overrides,
  };
}

function persisted(definition: NewTaskDefinition): TaskDefinition {
  return Object.freeze({
    id: definition.id,
    homeId: definition.homeId,
    title: definition.title,
    frequency: definition.frequency,
    weekday: definition.weekday,
    dayOfMonth: definition.dayOfMonth,
    assignedMembershipId: definition.assignedMembershipId,
    creatorMembershipId: definition.creatorMembershipId,
    nextOccurrenceDate: definition.nextOccurrenceDate,
    nextOccurrenceAt: new Date(definition.nextOccurrenceAt.toString()),
    deactivatedAt: null,
    createdAt: definition.createdAt,
    updatedAt: definition.createdAt,
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

function expectedCursor(
  frequency: CreateRecurringTaskDefinitionInput['frequency'],
  weekday: number | null,
  dayOfMonth: number | null,
  timeZone = 'UTC',
) {
  return computeInitialRecurrenceCursor({
    frequency,
    weekday,
    dayOfMonth,
    homeTimeZone: timeZone,
    createdAt: Temporal.Instant.from(OCCURRED_AT.toISOString()),
  });
}

type HarnessOptions = {
  insertError?: Error;
  lockError?: Error;
  homeArchived?: boolean;
  timezone?: string;
  memberships?: readonly ExactLockedMembership[];
};

function harness(options: HarnessOptions = {}) {
  const inserts: NewTaskDefinition[] = [];
  const lockCalls: { homeId: string; membershipIds: readonly string[] }[] = [];
  let committed = false;

  const deps: CreateRecurringTaskDefinitionDependencies = {
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
          timezone: options.timezone ?? 'UTC',
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
      insertDefinition(_tx, definition) {
        if (options.insertError) {
          return Promise.reject(options.insertError);
        }
        inserts.push(definition);
        return Promise.resolve(persisted(definition));
      },
    },
    clock: {
      now() {
        return OCCURRED_AT;
      },
    },
    ids: {
      next() {
        return DEFINITION_A;
      },
    },
  };

  return {
    create: createCreateRecurringTaskDefinition(deps),
    inserts,
    lockCalls,
    isCommitted: () => committed,
  };
}

void describe('createCreateRecurringTaskDefinition', () => {
  void it('creates a valid DAILY definition with the frozen initial cursor', async () => {
    const { create, inserts, lockCalls } = harness();
    const created = await create(input());
    const cursor = expectedCursor('DAILY', null, null);
    assert.equal(created.id, DEFINITION_A);
    assert.equal(created.title, 'Take out trash');
    assert.equal(created.frequency, 'DAILY');
    assert.equal(created.weekday, null);
    assert.equal(created.dayOfMonth, null);
    assert.equal(created.assignedMembershipId, null);
    assert.equal(created.creatorMembershipId, MEMBERSHIP);
    assert.equal(created.nextOccurrenceDate, cursor.occurrenceDate);
    assert.equal(created.deactivatedAt, null);
    assert.equal(created.createdAt.toISOString(), OCCURRED_AT.toISOString());
    const inserted = inserts[0];
    assert.ok(inserted);
    assert.equal(inserted.creatorMembershipId, MEMBERSHIP);
    assert.equal(inserted.nextOccurrenceDate, cursor.occurrenceDate);
    assert.equal(
      inserted.nextOccurrenceAt.toString(),
      cursor.occurrenceAt.toString(),
    );
    assert.equal(
      Temporal.Instant.compare(inserted.nextOccurrenceAt, cursor.occurrenceAt),
      0,
    );
    assert.equal(
      Temporal.Instant.compare(
        inserted.nextOccurrenceAt,
        Temporal.Instant.from(OCCURRED_AT.toISOString()),
      ) > 0,
      true,
    );
    assert.deepEqual(lockCalls, [
      { homeId: HOME, membershipIds: [MEMBERSHIP] },
    ]);
  });

  void it('creates valid WEEKLY and MONTHLY definitions', async () => {
    const weekly = harness();
    const monthly = harness();
    const weeklyCreated = await weekly.create(
      input({ frequency: 'WEEKLY', weekday: 1 }),
    );
    const monthlyCreated = await monthly.create(
      input({ frequency: 'MONTHLY', dayOfMonth: 15 }),
    );
    assert.equal(weeklyCreated.frequency, 'WEEKLY');
    assert.equal(weeklyCreated.weekday, 1);
    assert.equal(weeklyCreated.dayOfMonth, null);
    assert.equal(monthlyCreated.frequency, 'MONTHLY');
    assert.equal(monthlyCreated.weekday, null);
    assert.equal(monthlyCreated.dayOfMonth, 15);
    assert.equal(
      weeklyCreated.nextOccurrenceDate,
      expectedCursor('WEEKLY', 1, null).occurrenceDate,
    );
    assert.equal(
      monthlyCreated.nextOccurrenceDate,
      expectedCursor('MONTHLY', null, 15).occurrenceDate,
    );
  });

  void it('rejects invalid recurrence pairings and fractions', async () => {
    const { create, inserts, lockCalls } = harness();
    await assert.rejects(
      () => create(input({ frequency: 'DAILY', weekday: 1 })),
      InvalidRequestError,
    );
    await assert.rejects(
      () => create(input({ frequency: 'DAILY', dayOfMonth: 15 })),
      InvalidRequestError,
    );
    await assert.rejects(
      () => create(input({ frequency: 'WEEKLY' })),
      InvalidRequestError,
    );
    await assert.rejects(
      () => create(input({ frequency: 'WEEKLY', weekday: 1, dayOfMonth: 15 })),
      InvalidRequestError,
    );
    await assert.rejects(
      () => create(input({ frequency: 'WEEKLY', weekday: 0 })),
      InvalidRequestError,
    );
    await assert.rejects(
      () => create(input({ frequency: 'WEEKLY', weekday: 8 })),
      InvalidRequestError,
    );
    await assert.rejects(
      () => create(input({ frequency: 'WEEKLY', weekday: 1.5 })),
      InvalidRequestError,
    );
    await assert.rejects(
      () => create(input({ frequency: 'MONTHLY' })),
      InvalidRequestError,
    );
    await assert.rejects(
      () => create(input({ frequency: 'MONTHLY', weekday: 1, dayOfMonth: 15 })),
      InvalidRequestError,
    );
    await assert.rejects(
      () => create(input({ frequency: 'MONTHLY', dayOfMonth: 0 })),
      InvalidRequestError,
    );
    await assert.rejects(
      () => create(input({ frequency: 'MONTHLY', dayOfMonth: 32 })),
      InvalidRequestError,
    );
    await assert.rejects(
      () => create(input({ frequency: 'MONTHLY', dayOfMonth: 15.2 })),
      InvalidRequestError,
    );
    assert.deepEqual(inserts, []);
    assert.equal(lockCalls.length > 0, true);
  });

  void it('trims title ends and rejects empty titles before locking', async () => {
    const ok = harness();
    const created = await ok.create(input({ title: '  Café 家  chore  ' }));
    assert.equal(created.title, 'Café 家  chore');

    const empty = harness();
    await assert.rejects(
      () => empty.create(input({ title: '   ' })),
      InvalidRequestError,
    );
    assert.deepEqual(empty.lockCalls, []);
    assert.deepEqual(empty.inserts, []);
  });

  void it('accepts an active assignee and locks actor==assignee once', async () => {
    const assigned = harness();
    const created = await assigned.create(
      input({ assignedMembershipId: ASSIGNEE }),
    );
    assert.equal(created.assignedMembershipId, ASSIGNEE);
    assert.deepEqual(assigned.lockCalls, [
      { homeId: HOME, membershipIds: [MEMBERSHIP, ASSIGNEE] },
    ]);

    const self = harness();
    const selfCreated = await self.create(
      input({ assignedMembershipId: MEMBERSHIP }),
    );
    assert.equal(selfCreated.assignedMembershipId, MEMBERSHIP);
    assert.equal(selfCreated.creatorMembershipId, MEMBERSHIP);
    assert.deepEqual(self.lockCalls, [
      { homeId: HOME, membershipIds: [MEMBERSHIP] },
    ]);
  });

  void it('rejects ended, cross-Home, and unknown assignees', async () => {
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
          id: ASSIGNEE,
          userId: OTHER_USER,
          homeId: OTHER_HOME,
        }),
      ],
    });
    const unknown = harness({ memberships: [lockedMembership()] });

    await assert.rejects(
      () => ended.create(input({ assignedMembershipId: ASSIGNEE })),
      InvalidRequestError,
    );
    await assert.rejects(
      () => crossHome.create(input({ assignedMembershipId: ASSIGNEE })),
      InvalidRequestError,
    );
    await assert.rejects(
      () => unknown.create(input({ assignedMembershipId: ASSIGNEE })),
      InvalidRequestError,
    );
    assert.equal(ended.isCommitted(), false);
    assert.deepEqual(ended.inserts, []);
  });

  void it('rejects an old tenure and accepts a rejoined active tenure', async () => {
    const old = harness({
      memberships: [
        lockedMembership({ id: OLD_MEMBERSHIP, endedAt: OCCURRED_AT }),
      ],
    });
    await assert.rejects(
      () =>
        old.create(input({ actor: actor({ membershipId: OLD_MEMBERSHIP }) })),
      ConcealedNotFoundError,
    );

    const rejoined = harness();
    const created = await rejoined.create(input());
    assert.equal(created.creatorMembershipId, MEMBERSHIP);
  });

  void it('computes the cursor from the locked Home timezone and injected Clock', async () => {
    const { create, inserts } = harness({
      timezone: 'America/Los_Angeles',
    });
    await create(input());
    const cursor = expectedCursor('DAILY', null, null, 'America/Los_Angeles');
    const utcCursor = expectedCursor('DAILY', null, null, 'UTC');
    assert.equal(inserts[0]?.nextOccurrenceDate, cursor.occurrenceDate);
    assert.equal(
      inserts[0]?.nextOccurrenceAt.toString(),
      cursor.occurrenceAt.toString(),
    );
    assert.notEqual(
      cursor.occurrenceAt.toString(),
      utcCursor.occurrenceAt.toString(),
    );
    assert.equal(inserts[0]?.createdAt, OCCURRED_AT);
  });

  void it('leaves no definition when insert or revalidation fails', async () => {
    const insertFailed = harness({
      insertError: new Error('insert failed'),
    });
    const lockedOut = harness({
      lockError: new ConcealedNotFoundError(),
    });
    await assert.rejects(() => insertFailed.create(input()), /insert failed/);
    await assert.rejects(
      () => lockedOut.create(input()),
      ConcealedNotFoundError,
    );
    assert.equal(insertFailed.isCommitted(), false);
    assert.equal(lockedOut.isCommitted(), false);
    assert.deepEqual(lockedOut.inserts, []);
  });
});
