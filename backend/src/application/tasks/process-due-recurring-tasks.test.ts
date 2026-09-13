import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ExactLockedMembership } from '../../domains/homes/lock-home-and-exact-memberships.js';
import {
  parseHomeLocalDate,
  type DateString,
} from '../../domains/tasks/home-local-date.js';
import type {
  AdvanceTaskDefinitionCursor,
  NewRecurringTaskOccurrence,
  RecurringOccurrenceInsertResult,
} from '../../domains/tasks/repository.js';
import {
  computeNextRecurrenceCursor,
  resolveLocalMidnight,
  type TaskRecurrenceFrequency,
} from '../../domains/tasks/recurrence-cursor.js';
import type { TaskDefinition } from '../../domains/tasks/task-definition.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  createProcessDueRecurringTasks,
  type ProcessDueRecurringTasksDependencies,
} from './process-due-recurring-tasks.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBERSHIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CREATOR = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const WORKER_NOW = new Date('2026-09-12T18:00:00.000Z');
const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const TX: TransactionContext = {
  query: () => Promise.reject(new Error('unexpected direct query')),
};

function date(value: string): DateString {
  return parseHomeLocalDate(value);
}

function definition(
  overrides: Partial<TaskDefinition> & Pick<TaskDefinition, 'id'>,
  timezone = 'UTC',
): TaskDefinition {
  const nextOccurrenceDate =
    overrides.nextOccurrenceDate === undefined
      ? date('2026-09-12')
      : overrides.nextOccurrenceDate;
  return Object.freeze({
    homeId: HOME,
    title: 'Take out trash',
    frequency: 'DAILY',
    weekday: null,
    dayOfMonth: null,
    assignedMembershipId: MEMBERSHIP,
    creatorMembershipId: CREATOR,
    nextOccurrenceDate,
    nextOccurrenceAt:
      overrides.nextOccurrenceAt === undefined
        ? nextOccurrenceDate === null
          ? null
          : new Date(
              resolveLocalMidnight(nextOccurrenceDate, timezone)
                .epochMilliseconds,
            )
        : overrides.nextOccurrenceAt,
    deactivatedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  });
}

type StoredOccurrence = NewRecurringTaskOccurrence;

type HarnessOptions = {
  definitions?: readonly TaskDefinition[];
  timezone?: string;
  existingOccurrences?: readonly StoredOccurrence[];
  insertError?: Error;
  clockValues?: readonly Date[];
};

function harness(options: HarnessOptions = {}) {
  const timezone = options.timezone ?? 'UTC';
  let definitions = [...(options.definitions ?? [])];
  let occurrences = [...(options.existingOccurrences ?? [])];
  const insertedArguments: NewRecurringTaskOccurrence[] = [];
  const cursorArguments: AdvanceTaskDefinitionCursor[] = [];
  const candidateCalls: {
    workerNow: Date;
    excludedDefinitionIds: readonly string[];
  }[] = [];
  const lockCalls: {
    homeId: string;
    membershipIds: readonly string[];
  }[] = [];
  let clockCalls = 0;
  let idCounter = 0;

  const membership: ExactLockedMembership = Object.freeze({
    id: MEMBERSHIP,
    userId: '11111111-1111-4111-8111-111111111111',
    homeId: HOME,
    role: 'ROOMMATE',
    endedAt: null,
  });

  const deps: ProcessDueRecurringTasksDependencies = {
    async runTransaction(work) {
      const definitionsBefore = definitions;
      const occurrencesBefore = occurrences;
      definitions = [...definitions];
      occurrences = [...occurrences];
      try {
        return await work(TX);
      } catch (error) {
        definitions = definitionsBefore;
        occurrences = occurrencesBefore;
        throw error;
      }
    },
    tryLockHomeAndExactMemberships(_tx, input) {
      lockCalls.push({
        homeId: input.homeId,
        membershipIds: [...input.membershipIds],
      });
      return Promise.resolve({
        home: {
          id: input.homeId,
          archivedAt: null,
          timezone,
        },
        memberships: input.membershipIds.includes(MEMBERSHIP)
          ? [membership]
          : [],
      });
    },
    tasks: {
      findNextDueDefinitionCandidate(workerNow, excludedDefinitionIds) {
        candidateCalls.push({
          workerNow,
          excludedDefinitionIds: [...excludedDefinitionIds],
        });
        const candidate = definitions
          .filter(
            (item) =>
              item.deactivatedAt === null &&
              item.nextOccurrenceDate !== null &&
              item.nextOccurrenceAt !== null &&
              item.nextOccurrenceAt.getTime() <= workerNow.getTime() &&
              !excludedDefinitionIds.includes(item.id),
          )
          .sort((left, right) => {
            const instant =
              (left.nextOccurrenceAt?.getTime() ?? 0) -
              (right.nextOccurrenceAt?.getTime() ?? 0);
            return instant || left.id.localeCompare(right.id);
          })[0];
        return Promise.resolve(
          candidate === undefined
            ? null
            : {
                id: candidate.id,
                homeId: candidate.homeId,
                assignedMembershipId: candidate.assignedMembershipId,
              },
        );
      },
      lockDueDefinitionByHomeAndId(_tx, homeId, taskDefinitionId, workerNow) {
        const found = definitions.find(
          (item) =>
            item.homeId === homeId &&
            item.id === taskDefinitionId &&
            item.deactivatedAt === null &&
            item.nextOccurrenceAt !== null &&
            item.nextOccurrenceAt.getTime() <= workerNow.getTime(),
        );
        return Promise.resolve(found ?? null);
      },
      insertRecurringOccurrence(_tx, occurrence) {
        insertedArguments.push(occurrence);
        if (options.insertError !== undefined) {
          return Promise.reject(options.insertError);
        }
        const exists = occurrences.some(
          (item) =>
            item.taskDefinitionId === occurrence.taskDefinitionId &&
            item.scheduledFor === occurrence.scheduledFor,
        );
        if (exists) {
          return Promise.resolve<RecurringOccurrenceInsertResult>('reconciled');
        }
        occurrences.push(occurrence);
        return Promise.resolve<RecurringOccurrenceInsertResult>('generated');
      },
      advanceDefinitionCursor(_tx, input) {
        cursorArguments.push(input);
        const index = definitions.findIndex(
          (item) =>
            item.homeId === input.homeId && item.id === input.taskDefinitionId,
        );
        assert.notEqual(index, -1);
        const current = definitions[index];
        assert.ok(current);
        const advanced = Object.freeze({
          ...current,
          nextOccurrenceDate: input.nextOccurrenceDate,
          nextOccurrenceAt: new Date(input.nextOccurrenceAt.epochMilliseconds),
          updatedAt: input.updatedAt,
        });
        definitions[index] = advanced;
        return Promise.resolve(advanced);
      },
    },
    clock: {
      now() {
        const value =
          options.clockValues?.[clockCalls] ??
          options.clockValues?.at(-1) ??
          WORKER_NOW;
        clockCalls += 1;
        return value;
      },
    },
    ids: {
      next() {
        idCounter += 1;
        return `00000000-0000-7000-8000-${idCounter.toString().padStart(12, '0')}`;
      },
    },
  };

  return {
    process: createProcessDueRecurringTasks(deps),
    definitions: () => definitions,
    occurrences: () => occurrences,
    insertedArguments,
    cursorArguments,
    candidateCalls,
    lockCalls,
    clockCalls: () => clockCalls,
  };
}

function recurringDefinition(
  id: string,
  frequency: TaskRecurrenceFrequency,
  occurrenceDate: string,
  configuration: { weekday?: number; dayOfMonth?: number } = {},
  timezone = 'UTC',
): TaskDefinition {
  return definition(
    {
      id,
      frequency,
      weekday: configuration.weekday ?? null,
      dayOfMonth: configuration.dayOfMonth ?? null,
      nextOccurrenceDate: date(occurrenceDate),
    },
    timezone,
  );
}

void describe('createProcessDueRecurringTasks', () => {
  void it('takes one Clock snapshot and processes past and exact due definitions but not future ones', async () => {
    const due = definition({
      id: '00000000-0000-7000-8000-000000000001',
      nextOccurrenceDate: date('2026-09-11'),
    });
    const exact = definition({
      id: '00000000-0000-7000-8000-000000000002',
      nextOccurrenceDate: date('2026-09-12'),
      nextOccurrenceAt: new Date(WORKER_NOW),
    });
    const future = definition({
      id: '00000000-0000-7000-8000-000000000003',
      nextOccurrenceDate: date('2026-09-13'),
    });
    const laterClockValue = new Date('2030-01-01T00:00:00.000Z');
    const test = harness({
      definitions: [due, exact, future],
      clockValues: [WORKER_NOW, laterClockValue],
    });

    const result = await test.process();

    assert.equal(test.clockCalls(), 1);
    assert.equal(result.definitionsProcessed, 2);
    assert.equal(result.occurrencesGenerated, 3);
    assert.deepEqual(
      test.occurrences().map((item) => item.taskDefinitionId),
      [due.id, due.id, exact.id],
    );
    assert.equal(
      test.candidateCalls.every((call) => call.workerNow === WORKER_NOW),
      true,
    );
    assert.equal(
      test.cursorArguments.every((input) => input.updatedAt === WORKER_NOW),
      true,
    );
  });

  void it('generates frozen occurrence snapshots with definition fields and the shared worker timestamp', async () => {
    const source = definition({
      id: '00000000-0000-7000-8000-000000000010',
      title: 'Clean kitchen',
      nextOccurrenceDate: date('2026-09-12'),
      nextOccurrenceAt: new Date(WORKER_NOW),
    });
    const test = harness({ definitions: [source] });

    const result = await test.process();

    assert.deepEqual(result, {
      definitionsProcessed: 1,
      occurrencesGenerated: 1,
      occurrencesReconciled: 0,
      moreDueWorkLikely: false,
    });
    const occurrence = test.occurrences()[0];
    assert.ok(occurrence);
    assert.equal(Object.isFrozen(occurrence), true);
    assert.deepEqual(occurrence, {
      id: '00000000-0000-7000-8000-000000000001',
      homeId: HOME,
      taskDefinitionId: source.id,
      title: 'Clean kitchen',
      scheduledFor: date('2026-09-12'),
      assignedMembershipId: MEMBERSHIP,
      createdAt: WORKER_NOW,
    });
    assert.deepEqual(test.lockCalls, [
      { homeId: HOME, membershipIds: [MEMBERSHIP] },
    ]);
  });

  void it('advances DAILY, WEEKLY, and MONTHLY successors from logical dates', async () => {
    const cases = [
      {
        source: recurringDefinition(
          '00000000-0000-7000-8000-000000000021',
          'DAILY',
          '2026-09-12',
        ),
        expected: '2026-09-13',
      },
      {
        source: recurringDefinition(
          '00000000-0000-7000-8000-000000000022',
          'WEEKLY',
          '2026-09-07',
          { weekday: 1 },
        ),
        expected: '2026-09-14',
      },
      {
        source: recurringDefinition(
          '00000000-0000-7000-8000-000000000023',
          'MONTHLY',
          '2026-08-31',
          { dayOfMonth: 31 },
        ),
        expected: '2026-09-30',
      },
    ] as const;

    for (const item of cases) {
      const test = harness({ definitions: [item.source] });
      await test.process({ maxOccurrencesPerDefinition: 1 });
      assert.equal(
        test.definitions()[0]?.nextOccurrenceDate,
        date(item.expected),
      );
      const expectedCursor = computeNextRecurrenceCursor({
        frequency: item.source.frequency,
        weekday: item.source.weekday,
        dayOfMonth: item.source.dayOfMonth,
        homeTimeZone: 'UTC',
        previousOccurrenceDate: item.source.nextOccurrenceDate as DateString,
      });
      assert.equal(
        test.cursorArguments[0]?.nextOccurrenceAt.toString(),
        expectedCursor.occurrenceAt.toString(),
      );
    }
  });

  void it('catches up only to the occurrence cap and continues on the next invocation', async () => {
    const source = recurringDefinition(
      '00000000-0000-7000-8000-000000000030',
      'DAILY',
      '2026-09-08',
    );
    const test = harness({ definitions: [source] });

    const first = await test.process({ maxOccurrencesPerDefinition: 2 });
    assert.deepEqual(first, {
      definitionsProcessed: 1,
      occurrencesGenerated: 2,
      occurrencesReconciled: 0,
      moreDueWorkLikely: true,
    });
    assert.equal(test.definitions()[0]?.nextOccurrenceDate, date('2026-09-10'));

    const second = await test.process({ maxOccurrencesPerDefinition: 10 });
    assert.equal(second.occurrencesGenerated, 3);
    assert.equal(second.moreDueWorkLikely, false);
    assert.deepEqual(
      test.occurrences().map((item) => item.scheduledFor),
      [
        date('2026-09-08'),
        date('2026-09-09'),
        date('2026-09-10'),
        date('2026-09-11'),
        date('2026-09-12'),
      ],
    );
    assert.equal(test.definitions()[0]?.nextOccurrenceDate, date('2026-09-13'));
  });

  void it('processes distinct Apia logical dates that resolve to the same instant', async () => {
    const timezone = 'Pacific/Apia';
    const skipped = resolveLocalMidnight(date('2011-12-30'), timezone);
    const following = resolveLocalMidnight(date('2011-12-31'), timezone);
    assert.equal(skipped.toString(), following.toString());
    const workerNow = new Date(following.epochMilliseconds);
    const source = recurringDefinition(
      '00000000-0000-7000-8000-000000000040',
      'DAILY',
      '2011-12-30',
      {},
      timezone,
    );
    const test = harness({
      definitions: [source],
      timezone,
      clockValues: [workerNow],
    });

    const result = await test.process();

    assert.equal(result.occurrencesGenerated, 2);
    assert.deepEqual(
      test.occurrences().map((item) => item.scheduledFor),
      [date('2011-12-30'), date('2011-12-31')],
    );
    assert.equal(test.definitions()[0]?.nextOccurrenceDate, date('2012-01-01'));
  });

  void it('reconciles an existing occurrence without mutating its snapshot', async () => {
    const source = definition({
      id: '00000000-0000-7000-8000-000000000050',
      title: 'Current definition title',
      nextOccurrenceDate: date('2026-09-12'),
      nextOccurrenceAt: new Date(WORKER_NOW),
    });
    const existing = Object.freeze({
      id: '00000000-0000-7000-8000-000000000099',
      homeId: HOME,
      taskDefinitionId: source.id,
      title: 'Historical snapshot title',
      scheduledFor: date('2026-09-12'),
      assignedMembershipId: null,
      createdAt: CREATED_AT,
    });
    const test = harness({
      definitions: [source],
      existingOccurrences: [existing],
    });

    const result = await test.process();

    assert.equal(result.occurrencesGenerated, 0);
    assert.equal(result.occurrencesReconciled, 1);
    assert.equal(test.occurrences().length, 1);
    assert.equal(test.occurrences()[0], existing);
    assert.equal(existing.title, 'Historical snapshot title');
    assert.equal(existing.assignedMembershipId, null);
    assert.equal(test.definitions()[0]?.nextOccurrenceDate, date('2026-09-13'));
  });

  void it('does not move the cursor when occurrence insertion fails unexpectedly', async () => {
    const source = definition({
      id: '00000000-0000-7000-8000-000000000060',
      nextOccurrenceAt: new Date(WORKER_NOW),
    });
    const failure = new Error('unexpected insert failure');
    const test = harness({
      definitions: [source],
      insertError: failure,
    });

    await assert.rejects(() => test.process(), failure);

    assert.equal(test.insertedArguments.length, 1);
    assert.deepEqual(test.cursorArguments, []);
    assert.equal(test.definitions()[0], source);
    assert.deepEqual(test.occurrences(), []);
  });

  void it('bounds definitions per invocation and validates both positive integer limits', async () => {
    const definitions = [1, 2, 3].map((number) =>
      definition({
        id: `00000000-0000-7000-8000-${number.toString().padStart(12, '0')}`,
        nextOccurrenceAt: new Date(WORKER_NOW),
      }),
    );
    const test = harness({ definitions });

    const bounded = await test.process({
      maxDefinitions: 2,
      maxOccurrencesPerDefinition: 1,
    });

    assert.deepEqual(bounded, {
      definitionsProcessed: 2,
      occurrencesGenerated: 2,
      occurrencesReconciled: 0,
      moreDueWorkLikely: true,
    });
    assert.equal(test.occurrences().length, 2);

    for (const options of [
      { maxDefinitions: 0 },
      { maxDefinitions: -1 },
      { maxDefinitions: 1.5 },
      { maxOccurrencesPerDefinition: 0 },
      { maxOccurrencesPerDefinition: Number.POSITIVE_INFINITY },
    ]) {
      const invalid = harness();
      await assert.rejects(() => invalid.process(options), RangeError);
      assert.equal(invalid.clockCalls(), 0);
    }
  });
});
