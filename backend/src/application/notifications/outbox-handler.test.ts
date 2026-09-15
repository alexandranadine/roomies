import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  ExactLockedMembership,
  LockedHomeAndExactMemberships,
} from '../../domains/homes/lock-home-and-exact-memberships.js';
import {
  MAINTENANCE_CREATED_V1,
  MAINTENANCE_RESOLVED_V1,
} from '../../domains/maintenance/events.js';
import { MaintenanceNotificationSourceIntegrityError } from '../../domains/maintenance/errors.js';
import type { MaintenanceNotificationSource } from '../../domains/maintenance/find-maintenance-notification-source.js';
import { MEMBERSHIP_ROLE_CHANGED_V1 } from '../../domains/memberships/events.js';
import { MembershipNotificationSourceIntegrityError } from '../../domains/memberships/errors.js';
import type { MembershipRoleTransitionNotificationSource } from '../../domains/memberships/find-membership-notification-source.js';
import type { Notification } from '../../domains/notifications/notification.js';
import type {
  NewNotification,
  NotificationInsertResult,
  NotificationSourceKey,
} from '../../domains/notifications/repository.js';
import { SUPPLY_OBTAINED_V1 } from '../../domains/supplies/events.js';
import { SupplyNotificationSourceIntegrityError } from '../../domains/supplies/errors.js';
import type { SupplyNotificationSource } from '../../domains/supplies/find-supply-notification-source.js';
import { TASK_COMPLETED_V1 } from '../../domains/tasks/events.js';
import { TaskNotificationSourceIntegrityError } from '../../domains/tasks/errors.js';
import type { TaskNotificationSource } from '../../domains/tasks/find-task-notification-source.js';
import { ConcealedNotFoundError } from '../../platform/authz/index.js';
import type { JsonObject } from '../../platform/events/outbox-types.js';
import type { OutboxEvent } from '../../platform/outbox/outbox-event.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { NotificationProjectionIntegrityError } from './errors.js';
import {
  createNotificationOutboxHandler,
  NOTIFICATIONS_OUTBOX_EVENT_TYPES,
  NOTIFICATIONS_OUTBOX_HANDLER_ID,
} from './outbox-handler.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EVENT = '018f1e2c-7e3a-7000-8000-1234567890ad';
const ENTRY = '018f1e2c-7e3a-7000-8000-1234567890ab';
const OTHER_ENTRY = '018f1e2c-7e3a-7000-8000-1234567890ac';
const TRANSITION = '018f1e2c-7e3a-7000-8000-1234567890dd';
const TARGET = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ACTOR = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ASSIGNEE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const COMPLETER = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const CREATOR = '99999999-9999-4999-8999-999999999999';
const OBTAINER = '88888888-8888-4888-8888-888888888888';
const RECIPIENT = '77777777-7777-4777-8777-777777777777';
const ADMIN = '66666666-6666-4666-8666-666666666666';
const REJOINED = '55555555-5555-4555-8555-555555555555';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const NOTIFICATION_IDS = Object.freeze([
  '018f1e2c-7e3a-7000-8000-1234567890ae',
  '018f1e2c-7e3a-7000-8000-1234567890af',
  '018f1e2c-7e3a-7000-8000-1234567890b0',
]);
const OCCURRED_AT = new Date('2026-09-13T18:00:00.000Z');
const LATER = new Date('2026-09-13T19:00:00.000Z');
const ENDED_AT = new Date('2026-09-13T17:00:00.000Z');
const TX: TransactionContext = {
  query: () => Promise.reject(new Error('unexpected direct query')),
};

type SourceName = 'role' | 'task' | 'supply' | 'maintenance';

function event(
  eventType: string,
  payload: JsonObject,
  overrides: Partial<OutboxEvent> = {},
): OutboxEvent {
  return Object.freeze({
    eventId: EVENT,
    eventType,
    occurredAt: OCCURRED_AT,
    homeId: HOME,
    attemptCount: 0,
    payload,
    ...overrides,
  });
}

function roleEvent(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
  return event(
    MEMBERSHIP_ROLE_CHANGED_V1,
    { membershipId: TARGET, roleTransitionId: TRANSITION },
    overrides,
  );
}

function taskEvent(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
  return event(TASK_COMPLETED_V1, { taskInstanceId: ENTRY }, overrides);
}

function supplyEvent(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
  return event(SUPPLY_OBTAINED_V1, { supplyEntryId: ENTRY }, overrides);
}

function maintenanceEvent(
  eventType: typeof MAINTENANCE_CREATED_V1 | typeof MAINTENANCE_RESOLVED_V1,
  overrides: Partial<OutboxEvent> = {},
): OutboxEvent {
  return event(eventType, { maintenanceEntryId: ENTRY }, overrides);
}

function roleSource(
  overrides: Partial<MembershipRoleTransitionNotificationSource> = {},
): MembershipRoleTransitionNotificationSource {
  return Object.freeze({
    transitionId: TRANSITION,
    homeId: HOME,
    membershipId: TARGET,
    actorMembershipId: ACTOR,
    changedAt: OCCURRED_AT,
    ...overrides,
  });
}

function taskSource(
  overrides: Partial<TaskNotificationSource> = {},
): TaskNotificationSource {
  return Object.freeze({
    id: ENTRY,
    homeId: HOME,
    status: 'COMPLETED',
    assignedMembershipId: ASSIGNEE,
    completedAt: OCCURRED_AT,
    completedByMembershipId: COMPLETER,
    ...overrides,
  });
}

function supplySource(
  overrides: Partial<SupplyNotificationSource> = {},
): SupplyNotificationSource {
  return Object.freeze({
    id: ENTRY,
    homeId: HOME,
    status: 'OBTAINED',
    createdByMembershipId: CREATOR,
    obtainedAt: OCCURRED_AT,
    obtainedByMembershipId: OBTAINER,
    ...overrides,
  });
}

function maintenanceSource(
  overrides: Partial<MaintenanceNotificationSource> = {},
): MaintenanceNotificationSource {
  return Object.freeze({
    id: ENTRY,
    homeId: HOME,
    visibility: 'PRIVATE',
    status: 'OPEN',
    createdByMembershipId: CREATOR,
    createdAt: OCCURRED_AT,
    resolvedByMembershipId: null,
    resolvedAt: null,
    recipientMembershipIds: Object.freeze([CREATOR, RECIPIENT]),
    ...overrides,
  });
}

function resolvedMaintenanceSource(
  overrides: Partial<MaintenanceNotificationSource> = {},
): MaintenanceNotificationSource {
  return maintenanceSource({
    status: 'RESOLVED',
    resolvedByMembershipId: ACTOR,
    resolvedAt: OCCURRED_AT,
    ...overrides,
  });
}

function lockedMembership(
  id: string,
  overrides: Partial<ExactLockedMembership> = {},
): ExactLockedMembership {
  return Object.freeze({
    id,
    userId: OTHER_USER,
    homeId: HOME,
    role: 'ROOMMATE',
    endedAt: null,
    ...overrides,
  });
}

function storedNotification(
  row: NewNotification,
  overrides: Partial<Notification> = {},
): Notification {
  return Object.freeze({
    ...row,
    readAt: row.readAt ?? null,
    ...overrides,
  });
}

type HarnessOptions = Readonly<{
  roleSource?: MembershipRoleTransitionNotificationSource | null;
  taskSource?: TaskNotificationSource | null;
  supplySource?: SupplyNotificationSource | null;
  maintenanceSource?: MaintenanceNotificationSource | null;
  lockedMaintenanceSource?: MaintenanceNotificationSource | null;
  sourceErrors?: Partial<Record<SourceName, Error>>;
  lockError?: Error;
  lockHome?: LockedHomeAndExactMemberships['home'];
  lockMemberships?:
    | readonly ExactLockedMembership[]
    | ((
        input: Readonly<{ homeId: string; membershipIds: readonly string[] }>,
      ) => readonly ExactLockedMembership[]);
  insertResults?: (
    rows: readonly NewNotification[],
  ) => readonly NotificationInsertResult[];
  duplicate?: boolean;
  existing?:
    | Notification
    | null
    | ((
        key: NotificationSourceKey,
        rows: readonly NewNotification[],
      ) => Notification | null);
}>;

function harness(options: HarnessOptions = {}) {
  const sourceCalls: Record<SourceName, unknown[]> = {
    role: [],
    task: [],
    supply: [],
    maintenance: [],
  };
  const lockCalls: Array<{
    tx: TransactionContext;
    input: Readonly<{ homeId: string; membershipIds: readonly string[] }>;
  }> = [];
  const insertCalls: Array<readonly NewNotification[]> = [];
  const lookupCalls: Array<{
    tx: TransactionContext;
    key: NotificationSourceKey;
  }> = [];
  let idCalls = 0;

  const handler = createNotificationOutboxHandler({
    findMembershipRoleTransitionSource(tx, input) {
      sourceCalls.role.push({ tx, input });
      const error = options.sourceErrors?.role;
      if (error !== undefined) {
        return Promise.reject(error);
      }
      return Promise.resolve(
        options.roleSource === undefined ? roleSource() : options.roleSource,
      );
    },
    findTaskSource(tx, input) {
      sourceCalls.task.push({ tx, input });
      const error = options.sourceErrors?.task;
      if (error !== undefined) {
        return Promise.reject(error);
      }
      return Promise.resolve(
        options.taskSource === undefined ? taskSource() : options.taskSource,
      );
    },
    findSupplySource(tx, input) {
      sourceCalls.supply.push({ tx, input });
      const error = options.sourceErrors?.supply;
      if (error !== undefined) {
        return Promise.reject(error);
      }
      return Promise.resolve(
        options.supplySource === undefined
          ? supplySource()
          : options.supplySource,
      );
    },
    findMaintenanceSource(tx, input) {
      sourceCalls.maintenance.push({ tx, input });
      const error = options.sourceErrors?.maintenance;
      if (error !== undefined) {
        return Promise.reject(error);
      }
      if (
        input.lock === 'forUpdate' &&
        options.lockedMaintenanceSource !== undefined
      ) {
        return Promise.resolve(options.lockedMaintenanceSource);
      }
      return Promise.resolve(
        options.maintenanceSource === undefined
          ? maintenanceSource()
          : options.maintenanceSource,
      );
    },
    lockHomeAndExactMemberships(tx, input) {
      lockCalls.push({ tx, input });
      if (options.lockError !== undefined) {
        return Promise.reject(options.lockError);
      }
      const memberships =
        typeof options.lockMemberships === 'function'
          ? options.lockMemberships(input)
          : (options.lockMemberships ??
            input.membershipIds.map((id) => lockedMembership(id)));
      return Promise.resolve(
        Object.freeze({
          home:
            options.lockHome ??
            Object.freeze({
              id: HOME,
              archivedAt: null,
              timezone: 'UTC',
            }),
          memberships: Object.freeze([...memberships]),
        }),
      );
    },
    notifications: {
      insertNotification() {
        return Promise.reject(new Error('unexpected single-row insertion'));
      },
      insertNotifications(tx, rows) {
        assert.equal(tx, TX);
        insertCalls.push(rows);
        if (options.insertResults !== undefined) {
          return Promise.resolve(
            Object.freeze([...options.insertResults(rows)]),
          );
        }
        if (options.duplicate === true) {
          return Promise.resolve(
            Object.freeze(
              rows.map((row) =>
                Object.freeze({
                  outcome: 'duplicate_source_recipient_kind' as const,
                  sourceOutboxEventId: row.sourceOutboxEventId,
                  recipientMembershipId: row.recipientMembershipId,
                  kind: row.kind,
                }),
              ),
            ),
          );
        }
        return Promise.resolve(
          Object.freeze(
            rows.map((row) =>
              Object.freeze({
                outcome: 'inserted' as const,
                notification: storedNotification(row),
              }),
            ),
          ),
        );
      },
      findBySourceRecipientKind(tx, key) {
        lookupCalls.push({ tx, key });
        const rows = insertCalls.flat();
        if (typeof options.existing === 'function') {
          return Promise.resolve(options.existing(key, rows));
        }
        if (options.existing !== undefined) {
          return Promise.resolve(options.existing);
        }
        const row = rows.find(
          (candidate) =>
            candidate.sourceOutboxEventId === key.sourceOutboxEventId &&
            candidate.recipientMembershipId === key.recipientMembershipId &&
            candidate.kind === key.kind,
        );
        return Promise.resolve(
          row === undefined ? null : storedNotification(row),
        );
      },
    },
    ids: {
      next() {
        const id = NOTIFICATION_IDS[idCalls];
        idCalls += 1;
        if (id === undefined) {
          throw new Error('test exhausted deterministic notification IDs');
        }
        return id;
      },
    },
  });

  return {
    handler,
    sourceCalls,
    lockCalls,
    insertCalls,
    lookupCalls,
    idCalls: () => idCalls,
  };
}

async function expectProjectionFailure(
  run: () => Promise<void>,
): Promise<NotificationProjectionIntegrityError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof NotificationProjectionIntegrityError);
    return error;
  }
  assert.fail('expected NotificationProjectionIntegrityError');
}

function assertNoInsert(
  state: Pick<ReturnType<typeof harness>, 'insertCalls' | 'idCalls'>,
): void {
  assert.deepEqual(state.insertCalls, []);
  assert.equal(state.idCalls(), 0);
}

void describe('createNotificationOutboxHandler', () => {
  void it('registers the stable identity and frozen five-event matrix', () => {
    const { handler } = harness();
    assert.equal(handler.handlerId, NOTIFICATIONS_OUTBOX_HANDLER_ID);
    assert.equal(handler.handlerId, 'notifications');
    assert.deepEqual(handler.eventTypes, [
      MEMBERSHIP_ROLE_CHANGED_V1,
      TASK_COMPLETED_V1,
      SUPPLY_OBTAINED_V1,
      MAINTENANCE_CREATED_V1,
      MAINTENANCE_RESOLVED_V1,
    ]);
    assert.deepEqual(handler.eventTypes, NOTIFICATIONS_OUTBOX_EVENT_TYPES);
  });

  void describe('Membership role changes', () => {
    void it('notifies the exact target from the immutable transition', async () => {
      const state = harness();
      await state.handler.handle(TX, roleEvent());

      assert.deepEqual(state.sourceCalls.role, [
        {
          tx: TX,
          input: {
            roleTransitionId: TRANSITION,
            membershipId: TARGET,
            expectedHomeId: HOME,
          },
        },
      ]);
      assert.deepEqual(state.lockCalls, [
        { tx: TX, input: { homeId: HOME, membershipIds: [TARGET] } },
      ]);
      assert.deepEqual(state.insertCalls, [
        [
          {
            id: NOTIFICATION_IDS[0],
            homeId: HOME,
            recipientMembershipId: TARGET,
            sourceOutboxEventId: EVENT,
            kind: 'MEMBERSHIP_ROLE_CHANGED',
            sourceEntityType: 'MEMBERSHIP',
            sourceEntityId: TARGET,
            actorMembershipId: ACTOR,
            occurredAt: OCCURRED_AT,
            createdAt: OCCURRED_AT,
            readAt: null,
          },
        ],
      ]);
      assert.equal(state.idCalls(), 1);
      assert.deepEqual(state.sourceCalls.task, []);
      assert.deepEqual(state.sourceCalls.supply, []);
      assert.deepEqual(state.sourceCalls.maintenance, []);
    });

    void it('does not notify a target who changed their own role', async () => {
      const state = harness({
        roleSource: roleSource({ actorMembershipId: TARGET }),
      });
      await state.handler.handle(TX, roleEvent());
      assert.deepEqual(state.lockCalls[0]?.input.membershipIds, []);
      assertNoInsert(state);
    });

    void it('does not notify an ended target tenure', async () => {
      const state = harness({
        lockMemberships: [lockedMembership(TARGET, { endedAt: ENDED_AT })],
      });
      await state.handler.handle(TX, roleEvent());
      assertNoInsert(state);
    });

    void it('does not substitute a rejoined tenure for the target tenure', async () => {
      const state = harness({
        lockMemberships: [
          lockedMembership(REJOINED, { userId: USER, role: 'ADMIN' }),
        ],
      });
      await state.handler.handle(TX, roleEvent());
      assert.deepEqual(state.lockCalls[0]?.input.membershipIds, [TARGET]);
      assertNoInsert(state);
    });

    void it('is independent of the target current role', async () => {
      const state = harness({
        lockMemberships: [
          lockedMembership(TARGET, { userId: USER, role: 'ADMIN' }),
        ],
      });
      await state.handler.handle(TX, roleEvent());
      assert.equal(state.insertCalls[0]?.[0]?.recipientMembershipId, TARGET);
      assert.equal(state.insertCalls.length, 1);
    });

    void it('rejects a transition timestamp mismatch', async () => {
      const state = harness({
        roleSource: roleSource({ changedAt: LATER }),
      });
      await assert.rejects(
        () => state.handler.handle(TX, roleEvent()),
        NotificationProjectionIntegrityError,
      );
      assert.deepEqual(state.lockCalls, []);
      assertNoInsert(state);
    });

    void it('rejects contradictory transition identity and source failures', async () => {
      for (const contradictory of [
        roleSource({ transitionId: OTHER_ENTRY }),
        roleSource({ homeId: OTHER_HOME }),
        roleSource({ membershipId: ASSIGNEE }),
      ]) {
        const state = harness({ roleSource: contradictory });
        await assert.rejects(
          () => state.handler.handle(TX, roleEvent()),
          NotificationProjectionIntegrityError,
        );
        assertNoInsert(state);
      }

      const failed = harness({
        sourceErrors: {
          role: new MembershipNotificationSourceIntegrityError(),
        },
      });
      await assert.rejects(
        () => failed.handler.handle(TX, roleEvent()),
        NotificationProjectionIntegrityError,
      );
      assertNoInsert(failed);
    });

    void it('rejects malformed event identity before locking or persistence', async () => {
      const malformed = [
        roleEvent({ homeId: 'not-a-home-id' }),
        roleEvent({
          payload: { membershipId: 'bad', roleTransitionId: TRANSITION },
        }),
        roleEvent({ payload: { membershipId: TARGET } }),
      ];
      for (const outboxEvent of malformed) {
        const state = harness();
        await assert.rejects(
          () => state.handler.handle(TX, outboxEvent),
          NotificationProjectionIntegrityError,
        );
        assert.deepEqual(state.lockCalls, []);
        assertNoInsert(state);
      }
    });

    void it('accepts an exact persisted duplicate', async () => {
      const state = harness({ duplicate: true });
      await state.handler.handle(TX, roleEvent());
      assert.deepEqual(state.lookupCalls, [
        {
          tx: TX,
          key: {
            sourceOutboxEventId: EVENT,
            recipientMembershipId: TARGET,
            kind: 'MEMBERSHIP_ROLE_CHANGED',
          },
        },
      ]);
    });
  });

  void describe('Task completion', () => {
    void it('notifies the persisted instance assignee, not inferred assignment', async () => {
      const state = harness();
      await state.handler.handle(TX, taskEvent());
      assert.deepEqual(state.sourceCalls.task, [
        {
          tx: TX,
          input: { taskInstanceId: ENTRY, expectedHomeId: HOME },
        },
      ]);
      assert.deepEqual(state.lockCalls[0]?.input.membershipIds, [ASSIGNEE]);
      assert.deepEqual(state.insertCalls[0], [
        {
          id: NOTIFICATION_IDS[0],
          homeId: HOME,
          recipientMembershipId: ASSIGNEE,
          sourceOutboxEventId: EVENT,
          kind: 'ASSIGNED_TASK_COMPLETED',
          sourceEntityType: 'TASK',
          sourceEntityId: ENTRY,
          actorMembershipId: COMPLETER,
          occurredAt: OCCURRED_AT,
          createdAt: OCCURRED_AT,
          readAt: null,
        },
      ]);
    });

    void it('does not notify a self-completing assignee or an unassigned task', async () => {
      for (const source of [
        taskSource({
          assignedMembershipId: COMPLETER,
        }),
        taskSource({
          assignedMembershipId: null,
        }),
      ]) {
        const state = harness({ taskSource: source });
        await state.handler.handle(TX, taskEvent());
        assert.deepEqual(state.lockCalls[0]?.input.membershipIds, []);
        assertNoInsert(state);
      }
    });

    void it('does not notify an ended assignee tenure', async () => {
      const state = harness({
        lockMemberships: [lockedMembership(ASSIGNEE, { endedAt: ENDED_AT })],
      });
      await state.handler.handle(TX, taskEvent());
      assertNoInsert(state);
    });

    void it('does not substitute a rejoined tenure for the persisted assignee', async () => {
      const state = harness({
        lockMemberships: [
          lockedMembership(REJOINED, { userId: USER, role: 'ADMIN' }),
        ],
      });
      await state.handler.handle(TX, taskEvent());
      assert.deepEqual(state.lockCalls[0]?.input.membershipIds, [ASSIGNEE]);
      assertNoInsert(state);
    });

    void it('rejects a completion timestamp mismatch', async () => {
      const state = harness({
        taskSource: taskSource({ completedAt: LATER }),
      });
      await assert.rejects(
        () => state.handler.handle(TX, taskEvent()),
        NotificationProjectionIntegrityError,
      );
      assert.deepEqual(state.lockCalls, []);
      assertNoInsert(state);
    });

    void it('translates impossible canonical completion state', async () => {
      for (const source of [
        taskSource({ status: 'OPEN' }),
        taskSource({ completedAt: null }),
        taskSource({ completedByMembershipId: null }),
      ]) {
        const state = harness({ taskSource: source });
        await assert.rejects(
          () => state.handler.handle(TX, taskEvent()),
          NotificationProjectionIntegrityError,
        );
        assertNoInsert(state);
      }
      const failed = harness({
        sourceErrors: { task: new TaskNotificationSourceIntegrityError() },
      });
      await assert.rejects(
        () => failed.handler.handle(TX, taskEvent()),
        NotificationProjectionIntegrityError,
      );
    });

    void it('accepts an exact persisted duplicate', async () => {
      const state = harness({ duplicate: true });
      await state.handler.handle(TX, taskEvent());
      assert.equal(state.lookupCalls.length, 1);
      assert.equal(state.lookupCalls[0]?.key.kind, 'ASSIGNED_TASK_COMPLETED');
    });
  });

  void describe('Supply obtainment', () => {
    void it('notifies the creator and attributes the obtainer without claimant semantics', async () => {
      const state = harness();
      await state.handler.handle(TX, supplyEvent());
      assert.deepEqual(state.sourceCalls.supply, [
        {
          tx: TX,
          input: { supplyEntryId: ENTRY, expectedHomeId: HOME },
        },
      ]);
      assert.deepEqual(state.lockCalls[0]?.input.membershipIds, [CREATOR]);
      assert.deepEqual(state.insertCalls[0], [
        {
          id: NOTIFICATION_IDS[0],
          homeId: HOME,
          recipientMembershipId: CREATOR,
          sourceOutboxEventId: EVENT,
          kind: 'CREATED_SUPPLY_OBTAINED',
          sourceEntityType: 'SUPPLY',
          sourceEntityId: ENTRY,
          actorMembershipId: OBTAINER,
          occurredAt: OCCURRED_AT,
          createdAt: OCCURRED_AT,
          readAt: null,
        },
      ]);
      assert.equal(
        'claimantMembershipId' in (state.insertCalls[0]?.[0] ?? {}),
        false,
      );
    });

    void it('does not notify when the creator obtained their own entry', async () => {
      const state = harness({
        supplySource: supplySource({
          obtainedByMembershipId: CREATOR,
        }),
      });
      await state.handler.handle(TX, supplyEvent());
      assert.deepEqual(state.lockCalls[0]?.input.membershipIds, []);
      assertNoInsert(state);
    });

    void it('does not notify an ended creator tenure', async () => {
      const state = harness({
        lockMemberships: [lockedMembership(CREATOR, { endedAt: ENDED_AT })],
      });
      await state.handler.handle(TX, supplyEvent());
      assertNoInsert(state);
    });

    void it('does not substitute a rejoined tenure for the creator tenure', async () => {
      const state = harness({
        lockMemberships: [lockedMembership(REJOINED, { userId: USER })],
      });
      await state.handler.handle(TX, supplyEvent());
      assert.deepEqual(state.lockCalls[0]?.input.membershipIds, [CREATOR]);
      assertNoInsert(state);
    });

    void it('rejects an obtainment timestamp mismatch', async () => {
      const state = harness({
        supplySource: supplySource({ obtainedAt: LATER }),
      });
      await assert.rejects(
        () => state.handler.handle(TX, supplyEvent()),
        NotificationProjectionIntegrityError,
      );
      assert.deepEqual(state.lockCalls, []);
      assertNoInsert(state);
    });

    void it('translates impossible canonical obtainment state', async () => {
      for (const source of [
        supplySource({ status: 'OPEN' }),
        supplySource({ obtainedAt: null }),
        supplySource({ obtainedByMembershipId: null }),
      ]) {
        const state = harness({ supplySource: source });
        await assert.rejects(
          () => state.handler.handle(TX, supplyEvent()),
          NotificationProjectionIntegrityError,
        );
        assertNoInsert(state);
      }
      const failed = harness({
        sourceErrors: { supply: new SupplyNotificationSourceIntegrityError() },
      });
      await assert.rejects(
        () => failed.handler.handle(TX, supplyEvent()),
        NotificationProjectionIntegrityError,
      );
    });

    void it('accepts an exact persisted duplicate', async () => {
      const state = harness({ duplicate: true });
      await state.handler.handle(TX, supplyEvent());
      assert.equal(state.lookupCalls.length, 1);
      assert.equal(state.lookupCalls[0]?.key.kind, 'CREATED_SUPPLY_OBTAINED');
    });
  });

  void describe('Private Maintenance', () => {
    void it('uses exact recipients and excludes the event-specific actor', async () => {
      const recipients = Object.freeze([CREATOR, ACTOR, RECIPIENT]);
      const created = harness({
        maintenanceSource: maintenanceSource({
          recipientMembershipIds: recipients,
        }),
      });
      await created.handler.handle(
        TX,
        maintenanceEvent(MAINTENANCE_CREATED_V1),
      );
      assert.deepEqual(created.lockCalls[0]?.input.membershipIds, [
        ACTOR,
        RECIPIENT,
      ]);
      assert.deepEqual(
        created.insertCalls[0]?.map((row) => row.recipientMembershipId),
        [RECIPIENT, ACTOR],
      );
      assert.ok(
        created.insertCalls[0]?.every(
          (row) =>
            row.kind === 'PRIVATE_MAINTENANCE_CREATED' &&
            row.actorMembershipId === CREATOR,
        ),
      );

      const resolved = harness({
        maintenanceSource: resolvedMaintenanceSource({
          recipientMembershipIds: recipients,
        }),
      });
      await resolved.handler.handle(
        TX,
        maintenanceEvent(MAINTENANCE_RESOLVED_V1),
      );
      assert.deepEqual(resolved.lockCalls[0]?.input.membershipIds, [
        CREATOR,
        RECIPIENT,
      ]);
      assert.deepEqual(
        resolved.insertCalls[0]?.map((row) => row.recipientMembershipId),
        [RECIPIENT, CREATOR],
      );
      assert.ok(
        resolved.insertCalls[0]?.every(
          (row) =>
            row.kind === 'PRIVATE_MAINTENANCE_RESOLVED' &&
            row.actorMembershipId === ACTOR,
        ),
      );
    });

    void it('inserts all eligible recipients in one deterministic call', async () => {
      const state = harness({
        maintenanceSource: maintenanceSource({
          recipientMembershipIds: Object.freeze([CREATOR, ASSIGNEE, RECIPIENT]),
        }),
      });
      await state.handler.handle(TX, maintenanceEvent(MAINTENANCE_CREATED_V1));

      assert.equal(state.insertCalls.length, 1);
      assert.deepEqual(
        state.insertCalls[0]?.map((row) => ({
          id: row.id,
          recipientMembershipId: row.recipientMembershipId,
        })),
        [
          { id: NOTIFICATION_IDS[0], recipientMembershipId: RECIPIENT },
          { id: NOTIFICATION_IDS[1], recipientMembershipId: ASSIGNEE },
        ],
      );
      assert.equal(state.idCalls(), 2);
    });

    void it('does not add an Admin outside the exact private recipients', async () => {
      const state = harness({
        maintenanceSource: maintenanceSource({
          recipientMembershipIds: Object.freeze([RECIPIENT]),
        }),
        lockMemberships: [
          lockedMembership(RECIPIENT),
          lockedMembership(ADMIN, { role: 'ADMIN' }),
        ],
      });
      await state.handler.handle(TX, maintenanceEvent(MAINTENANCE_CREATED_V1));
      assert.deepEqual(state.lockCalls[0]?.input.membershipIds, [RECIPIENT]);
      assert.deepEqual(
        state.insertCalls[0]?.map((row) => row.recipientMembershipId),
        [RECIPIENT],
      );
    });

    void it('no-ops for household visibility before locking', async () => {
      const state = harness({
        maintenanceSource: maintenanceSource({
          visibility: 'HOUSEHOLD',
          recipientMembershipIds: Object.freeze([]),
        }),
      });
      await state.handler.handle(TX, maintenanceEvent(MAINTENANCE_CREATED_V1));
      assert.deepEqual(state.lockCalls, []);
      assertNoInsert(state);
    });

    void it('accepts a delayed create after the canonical entry resolved', async () => {
      const state = harness({
        maintenanceSource: resolvedMaintenanceSource({
          createdAt: OCCURRED_AT,
          resolvedAt: LATER,
          recipientMembershipIds: Object.freeze([CREATOR, RECIPIENT]),
        }),
      });
      await state.handler.handle(TX, maintenanceEvent(MAINTENANCE_CREATED_V1));
      assert.equal(state.insertCalls.length, 1);
      assert.equal(
        state.insertCalls[0]?.[0]?.kind,
        'PRIVATE_MAINTENANCE_CREATED',
      );
      assert.equal(state.insertCalls[0]?.[0]?.actorMembershipId, CREATOR);
    });

    void it('rejects create timestamp and resolved status/timestamp failures', async () => {
      const failures: Array<{
        source: MaintenanceNotificationSource;
        outboxEvent: OutboxEvent;
      }> = [
        {
          source: maintenanceSource({ createdAt: LATER }),
          outboxEvent: maintenanceEvent(MAINTENANCE_CREATED_V1),
        },
        {
          source: maintenanceSource(),
          outboxEvent: maintenanceEvent(MAINTENANCE_RESOLVED_V1),
        },
        {
          source: resolvedMaintenanceSource({ resolvedAt: LATER }),
          outboxEvent: maintenanceEvent(MAINTENANCE_RESOLVED_V1),
        },
        {
          source: resolvedMaintenanceSource({
            resolvedByMembershipId: null,
          }),
          outboxEvent: maintenanceEvent(MAINTENANCE_RESOLVED_V1),
        },
      ];
      for (const failure of failures) {
        const state = harness({ maintenanceSource: failure.source });
        await assert.rejects(
          () => state.handler.handle(TX, failure.outboxEvent),
          NotificationProjectionIntegrityError,
        );
        assert.deepEqual(state.lockCalls, []);
        assertNoInsert(state);
      }
    });

    void it('no-ops when either Maintenance event source is missing', async () => {
      for (const eventType of [
        MAINTENANCE_CREATED_V1,
        MAINTENANCE_RESOLVED_V1,
      ] as const) {
        const state = harness({ maintenanceSource: null });
        await state.handler.handle(TX, maintenanceEvent(eventType));
        assert.deepEqual(state.lockCalls, []);
        assertNoInsert(state);
      }
    });

    void it('does not insert from a stale peek after the locked re-read is absent', async () => {
      const state = harness({
        maintenanceSource: maintenanceSource(),
        lockedMaintenanceSource: null,
      });
      await state.handler.handle(TX, maintenanceEvent(MAINTENANCE_CREATED_V1));
      assert.equal(state.sourceCalls.maintenance.length, 2);
      assert.equal(
        (
          state.sourceCalls.maintenance[0] as {
            input: { lock?: string };
          }
        ).input.lock,
        undefined,
      );
      assert.equal(
        (
          state.sourceCalls.maintenance[1] as {
            input: { lock?: string };
          }
        ).input.lock,
        'forUpdate',
      );
      assert.equal(state.lockCalls.length, 1);
      assertNoInsert(state);
    });

    void it('no-ops when the exact lock reports an archived or missing Home', async () => {
      const state = harness({ lockError: new ConcealedNotFoundError() });
      await state.handler.handle(TX, maintenanceEvent(MAINTENANCE_CREATED_V1));
      assert.equal(state.lockCalls.length, 1);
      assertNoInsert(state);
    });

    void it('accepts exact duplicates for both Maintenance event kinds', async () => {
      for (const scenario of [
        {
          source: maintenanceSource(),
          eventType: MAINTENANCE_CREATED_V1,
          kind: 'PRIVATE_MAINTENANCE_CREATED',
          duplicateCount: 1,
        },
        {
          source: resolvedMaintenanceSource(),
          eventType: MAINTENANCE_RESOLVED_V1,
          kind: 'PRIVATE_MAINTENANCE_RESOLVED',
          duplicateCount: 2,
        },
      ] as const) {
        const state = harness({
          maintenanceSource: scenario.source,
          duplicate: true,
        });
        await state.handler.handle(TX, maintenanceEvent(scenario.eventType));
        assert.equal(state.lookupCalls.length, scenario.duplicateCount);
        assert.ok(
          state.lookupCalls.every((call) => call.key.kind === scenario.kind),
        );
      }
    });

    void it('rejects a cross-Home membership returned by the exact lock', async () => {
      const state = harness({
        lockMemberships: [lockedMembership(RECIPIENT, { homeId: OTHER_HOME })],
      });
      await assert.rejects(
        () =>
          state.handler.handle(TX, maintenanceEvent(MAINTENANCE_CREATED_V1)),
        NotificationProjectionIntegrityError,
      );
      assertNoInsert(state);
    });

    void it('replaces protected source failures with a stable safe message', async () => {
      const protectedValue = 'leaking private maintenance title';
      const state = harness({
        sourceErrors: {
          maintenance: new MaintenanceNotificationSourceIntegrityError(),
        },
      });
      const error = await expectProjectionFailure(() =>
        state.handler.handle(
          TX,
          maintenanceEvent(MAINTENANCE_CREATED_V1, {
            payload: {
              maintenanceEntryId: ENTRY,
              protectedValue,
            },
          }),
        ),
      );
      assert.equal(error.name, 'NotificationProjectionIntegrityError');
      assert.equal(error.message, 'Notification projection integrity failure');
      assert.doesNotMatch(error.message, new RegExp(ENTRY));
      assert.doesNotMatch(error.message, new RegExp(protectedValue));
      assertNoInsert(state);
    });
  });

  void describe('Persistence integrity', () => {
    void it('rejects a duplicate whose persisted row contradicts the plan', async () => {
      const state = harness({
        duplicate: true,
        existing(_key, rows) {
          const row = rows[0];
          assert.ok(row !== undefined);
          return storedNotification(row, { sourceEntityId: OTHER_ENTRY });
        },
      });
      await assert.rejects(
        () => state.handler.handle(TX, roleEvent()),
        NotificationProjectionIntegrityError,
      );
    });

    void it('rejects persistence result cardinality that differs from the batch', async () => {
      const state = harness({
        insertResults: () => Object.freeze([]),
      });
      await assert.rejects(
        () => state.handler.handle(TX, roleEvent()),
        NotificationProjectionIntegrityError,
      );
      assert.equal(state.insertCalls.length, 1);
      assert.deepEqual(state.lookupCalls, []);
    });
  });
});
