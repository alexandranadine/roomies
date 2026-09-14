import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ActivityInsertResult } from '../../domains/activity/repository.js';
import {
  MAINTENANCE_CREATED_V1,
  MAINTENANCE_RESOLVED_V1,
} from '../../domains/maintenance/events.js';
import { MaintenanceActivitySourceIntegrityError } from '../../domains/maintenance/errors.js';
import type { MaintenanceActivitySource } from '../../domains/maintenance/find-maintenance-activity-source.js';
import { SupplyActivitySourceIntegrityError } from '../../domains/supplies/errors.js';
import { SUPPLY_OBTAINED_V1 } from '../../domains/supplies/events.js';
import type { SupplyActivitySource } from '../../domains/supplies/find-supply-activity-source.js';
import { MembershipActivitySourceIntegrityError } from '../../domains/memberships/errors.js';
import {
  MEMBERSHIP_ENDED_V1,
  MEMBERSHIP_ROLE_CHANGED_V1,
  MEMBERSHIP_STARTED_V1,
} from '../../domains/memberships/events.js';
import type {
  MembershipEndedActivitySource,
  MembershipRoleTransitionActivitySource,
  MembershipStartedActivitySource,
} from '../../domains/memberships/find-membership-activity-source.js';
import { TaskActivitySourceIntegrityError } from '../../domains/tasks/errors.js';
import { TASK_COMPLETED_V1 } from '../../domains/tasks/events.js';
import type { TaskActivitySource } from '../../domains/tasks/find-task-activity-source.js';
import type { OutboxEvent } from '../../platform/outbox/outbox-event.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { ActivityProjectionIntegrityError } from './errors.js';
import {
  ACTIVITY_OUTBOX_HANDLER_ID,
  createActivityOutboxHandler,
} from './outbox-handler.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENTRY = '018f1e2c-7e3a-7000-8000-1234567890ab';
const EVENT = '018f1e2c-7e3a-7000-8000-1234567890ad';
const ACTIVITY_ID = '018f1e2c-7e3a-7000-8000-1234567890ae';
const CREATOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RESOLVER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const RECIPIENT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const COMPLETER = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const OBTAINER = '99999999-9999-4999-8999-999999999999';
const SUBJECT = '018f1e2c-7e3a-7000-8000-1234567890bb';
const ACTOR = '018f1e2c-7e3a-7000-8000-1234567890cc';
const TRANSITION = '018f1e2c-7e3a-7000-8000-1234567890dd';
const OCCURRED_AT = new Date('2026-09-13T18:00:00.000Z');
const TX: TransactionContext = {
  query: () => Promise.reject(new Error('unexpected direct query')),
};

function event(
  overrides: Partial<OutboxEvent> & { eventType?: string } = {},
): OutboxEvent {
  return Object.freeze({
    eventId: EVENT,
    eventType: overrides.eventType ?? MAINTENANCE_CREATED_V1,
    occurredAt: OCCURRED_AT,
    homeId: overrides.homeId === undefined ? HOME : overrides.homeId,
    attemptCount: 0,
    payload: overrides.payload ?? { maintenanceEntryId: ENTRY },
  });
}

function maintenanceSource(
  overrides: Partial<MaintenanceActivitySource> = {},
): MaintenanceActivitySource {
  return Object.freeze({
    id: ENTRY,
    homeId: HOME,
    visibility: 'HOUSEHOLD',
    status: 'OPEN',
    createdByMembershipId: CREATOR,
    resolvedByMembershipId: null,
    resolvedAt: null,
    audienceMembershipIds: Object.freeze([]),
    ...overrides,
  });
}

function completedTaskSource(
  overrides: Partial<TaskActivitySource> = {},
): TaskActivitySource {
  return Object.freeze({
    id: ENTRY,
    homeId: HOME,
    status: 'COMPLETED',
    completedAt: OCCURRED_AT,
    completedByMembershipId: COMPLETER,
    ...overrides,
  });
}

function obtainedSupplySource(
  overrides: Partial<SupplyActivitySource> = {},
): SupplyActivitySource {
  return Object.freeze({
    id: ENTRY,
    homeId: HOME,
    status: 'OBTAINED',
    obtainedAt: OCCURRED_AT,
    obtainedByMembershipId: OBTAINER,
    ...overrides,
  });
}

function startedMembershipSource(
  overrides: Partial<MembershipStartedActivitySource> = {},
): MembershipStartedActivitySource {
  return Object.freeze({
    membershipId: SUBJECT,
    homeId: HOME,
    joinedAt: OCCURRED_AT,
    ...overrides,
  });
}

function endedMembershipSource(
  overrides: Partial<MembershipEndedActivitySource> = {},
): MembershipEndedActivitySource {
  return Object.freeze({
    membershipId: SUBJECT,
    homeId: HOME,
    endedAt: OCCURRED_AT,
    endedByMembershipId: ACTOR,
    ...overrides,
  });
}

function roleTransitionSource(
  overrides: Partial<MembershipRoleTransitionActivitySource> = {},
): MembershipRoleTransitionActivitySource {
  return Object.freeze({
    transitionId: TRANSITION,
    homeId: HOME,
    membershipId: SUBJECT,
    actorMembershipId: ACTOR,
    changedAt: OCCURRED_AT,
    ...overrides,
  });
}

type HarnessOptions = {
  source?: MaintenanceActivitySource | null;
  sourceError?: Error;
  taskSource?: TaskActivitySource | null;
  taskSourceError?: Error;
  supplySource?: SupplyActivitySource | null;
  supplySourceError?: Error;
  startedSource?: MembershipStartedActivitySource | null;
  startedSourceError?: Error;
  endedSource?: MembershipEndedActivitySource | null;
  endedSourceError?: Error;
  roleSource?: MembershipRoleTransitionActivitySource | null;
  roleSourceError?: Error;
  insertResult?: ActivityInsertResult;
  insertError?: Error;
};

function harness(options: HarnessOptions = {}) {
  const homeVisible: unknown[] = [];
  const sourceAuthorized: unknown[] = [];
  let uuidCalls = 0;

  const handler = createActivityOutboxHandler({
    findMaintenanceActivitySource() {
      if (options.sourceError) {
        return Promise.reject(options.sourceError);
      }
      return Promise.resolve(
        options.source === undefined ? maintenanceSource() : options.source,
      );
    },
    findTaskActivitySource() {
      if (options.taskSourceError) {
        return Promise.reject(options.taskSourceError);
      }
      return Promise.resolve(
        options.taskSource === undefined
          ? completedTaskSource()
          : options.taskSource,
      );
    },
    findSupplyActivitySource() {
      if (options.supplySourceError) {
        return Promise.reject(options.supplySourceError);
      }
      return Promise.resolve(
        options.supplySource === undefined
          ? obtainedSupplySource()
          : options.supplySource,
      );
    },
    findMembershipStartedActivitySource() {
      if (options.startedSourceError) {
        return Promise.reject(options.startedSourceError);
      }
      return Promise.resolve(
        options.startedSource === undefined
          ? startedMembershipSource()
          : options.startedSource,
      );
    },
    findMembershipEndedActivitySource() {
      if (options.endedSourceError) {
        return Promise.reject(options.endedSourceError);
      }
      return Promise.resolve(
        options.endedSource === undefined
          ? endedMembershipSource()
          : options.endedSource,
      );
    },
    findMembershipRoleTransitionActivitySource() {
      if (options.roleSourceError) {
        return Promise.reject(options.roleSourceError);
      }
      return Promise.resolve(
        options.roleSource === undefined
          ? roleTransitionSource()
          : options.roleSource,
      );
    },
    activity: {
      insertHomeVisibleActivity(_tx, activity) {
        homeVisible.push(activity);
        if (options.insertError) {
          return Promise.reject(options.insertError);
        }
        return Promise.resolve(
          options.insertResult ?? {
            outcome: 'inserted' as const,
            activity: {
              ...activity,
              visibilityClass: 'HOME_VISIBLE' as const,
            },
          },
        );
      },
      insertSourceAuthorizedActivity(_tx, activity, recipients) {
        sourceAuthorized.push({ activity, recipients });
        if (options.insertError) {
          return Promise.reject(options.insertError);
        }
        return Promise.resolve(
          options.insertResult ?? {
            outcome: 'inserted' as const,
            activity: {
              ...activity,
              visibilityClass: 'SOURCE_AUTHORIZED' as const,
            },
          },
        );
      },
    },
    ids: {
      next() {
        uuidCalls += 1;
        return ACTIVITY_ID;
      },
    },
  });

  return {
    handler,
    homeVisible,
    sourceAuthorized,
    uuidCalls: () => uuidCalls,
  };
}

void describe('createActivityOutboxHandler', () => {
  void it('registers the activity identity for current event types', () => {
    const { handler } = harness();
    assert.equal(handler.handlerId, ACTIVITY_OUTBOX_HANDLER_ID);
    assert.deepEqual(handler.eventTypes, [
      MAINTENANCE_CREATED_V1,
      MAINTENANCE_RESOLVED_V1,
      TASK_COMPLETED_V1,
      SUPPLY_OBTAINED_V1,
      MEMBERSHIP_STARTED_V1,
      MEMBERSHIP_ENDED_V1,
      MEMBERSHIP_ROLE_CHANGED_V1,
    ]);
  });

  void it('projects HOUSEHOLD create as HOME_VISIBLE with the creator Membership', async () => {
    const { handler, homeVisible, sourceAuthorized, uuidCalls } = harness();
    await handler.handle(TX, event());
    assert.equal(homeVisible.length, 1);
    assert.deepEqual(sourceAuthorized, []);
    assert.equal(uuidCalls(), 1);
    assert.deepEqual(homeVisible[0], {
      id: ACTIVITY_ID,
      homeId: HOME,
      sourceOutboxEventId: EVENT,
      sourceEntityType: 'MAINTENANCE',
      sourceEntityId: ENTRY,
      eventType: MAINTENANCE_CREATED_V1,
      actorMembershipId: CREATOR,
      occurredAt: OCCURRED_AT,
      createdAt: OCCURRED_AT,
    });
  });

  void it('projects PRIVATE create as SOURCE_AUTHORIZED with exact audience', async () => {
    const { handler, homeVisible, sourceAuthorized } = harness({
      source: maintenanceSource({
        visibility: 'PRIVATE',
        audienceMembershipIds: Object.freeze([CREATOR, RECIPIENT]),
      }),
    });
    await handler.handle(TX, event());
    assert.deepEqual(homeVisible, []);
    assert.equal(sourceAuthorized.length, 1);
    const row = sourceAuthorized[0] as {
      activity: { actorMembershipId: string; visibilityClass?: string };
      recipients: readonly string[];
    };
    assert.deepEqual(row.recipients, [CREATOR, RECIPIENT]);
    assert.equal(row.activity.actorMembershipId, CREATOR);
    assert.equal('userId' in row.activity, false);
    assert.equal('title' in row.activity, false);
    assert.equal('details' in row.activity, false);
  });

  void it('projects resolve with the canonical resolver Membership', async () => {
    const { handler, homeVisible } = harness({
      source: maintenanceSource({
        status: 'RESOLVED',
        resolvedByMembershipId: RESOLVER,
        resolvedAt: OCCURRED_AT,
      }),
    });
    await handler.handle(TX, event({ eventType: MAINTENANCE_RESOLVED_V1 }));
    assert.equal(
      (homeVisible[0] as { actorMembershipId: string }).actorMembershipId,
      RESOLVER,
    );
    assert.equal(
      (homeVisible[0] as { eventType: string }).eventType,
      MAINTENANCE_RESOLVED_V1,
    );
  });

  void it('no-ops when the canonical source is missing', async () => {
    const { handler, homeVisible, sourceAuthorized, uuidCalls } = harness({
      source: null,
    });
    await handler.handle(TX, event());
    assert.deepEqual(homeVisible, []);
    assert.deepEqual(sourceAuthorized, []);
    assert.equal(uuidCalls(), 0);
  });

  void it('treats duplicate sourceOutboxEvent as successful replay', async () => {
    const { handler, homeVisible } = harness({
      insertResult: {
        outcome: 'duplicate_source_outbox_event',
        sourceOutboxEventId: EVENT,
      },
    });
    await handler.handle(TX, event());
    assert.equal(homeVisible.length, 1);
  });

  void it('raises integrity failure on Home mismatch', async () => {
    const { handler, homeVisible } = harness({
      sourceError: new MaintenanceActivitySourceIntegrityError(),
    });
    await assert.rejects(
      () => handler.handle(TX, event({ homeId: OTHER_HOME })),
      ActivityProjectionIntegrityError,
    );
    assert.deepEqual(homeVisible, []);
  });

  void it('raises integrity failure when resolve state is impossible', async () => {
    const { handler, homeVisible } = harness({
      source: maintenanceSource({
        status: 'OPEN',
        resolvedByMembershipId: null,
        resolvedAt: null,
      }),
    });
    await assert.rejects(
      () => handler.handle(TX, event({ eventType: MAINTENANCE_RESOLVED_V1 })),
      ActivityProjectionIntegrityError,
    );
    assert.deepEqual(homeVisible, []);
  });

  void it('still projects created events after the source has resolved', async () => {
    const { handler, homeVisible } = harness({
      source: maintenanceSource({
        status: 'RESOLVED',
        resolvedByMembershipId: RESOLVER,
        resolvedAt: OCCURRED_AT,
      }),
    });
    await handler.handle(TX, event());
    assert.equal(homeVisible.length, 1);
    assert.equal(
      (homeVisible[0] as { actorMembershipId: string }).actorMembershipId,
      CREATOR,
    );
  });

  void it('projects completed Task as HOME_VISIBLE with canonical completer', async () => {
    const { handler, homeVisible, sourceAuthorized, uuidCalls } = harness();
    await handler.handle(
      TX,
      event({
        eventType: TASK_COMPLETED_V1,
        payload: { taskInstanceId: ENTRY },
      }),
    );
    assert.equal(homeVisible.length, 1);
    assert.deepEqual(sourceAuthorized, []);
    assert.equal(uuidCalls(), 1);
    assert.deepEqual(homeVisible[0], {
      id: ACTIVITY_ID,
      homeId: HOME,
      sourceOutboxEventId: EVENT,
      sourceEntityType: 'TASK',
      sourceEntityId: ENTRY,
      eventType: TASK_COMPLETED_V1,
      actorMembershipId: COMPLETER,
      occurredAt: OCCURRED_AT,
      createdAt: OCCURRED_AT,
    });
    assert.equal(
      (homeVisible[0] as { actorMembershipId: string }).actorMembershipId,
      COMPLETER,
    );
    assert.notEqual(
      (homeVisible[0] as { actorMembershipId: string }).actorMembershipId,
      CREATOR,
    );
    assert.equal('title' in (homeVisible[0] as object), false);
    assert.equal('assignedMembershipId' in (homeVisible[0] as object), false);
    assert.equal('userId' in (homeVisible[0] as object), false);
  });

  void it('no-ops when the canonical Task source is missing', async () => {
    const { handler, homeVisible, uuidCalls } = harness({ taskSource: null });
    await handler.handle(
      TX,
      event({
        eventType: TASK_COMPLETED_V1,
        payload: { taskInstanceId: ENTRY },
      }),
    );
    assert.deepEqual(homeVisible, []);
    assert.equal(uuidCalls(), 0);
  });

  void it('treats duplicate Task sourceOutboxEvent as successful replay', async () => {
    const { handler, homeVisible } = harness({
      insertResult: {
        outcome: 'duplicate_source_outbox_event',
        sourceOutboxEventId: EVENT,
      },
    });
    await handler.handle(
      TX,
      event({
        eventType: TASK_COMPLETED_V1,
        payload: { taskInstanceId: ENTRY },
      }),
    );
    assert.equal(homeVisible.length, 1);
  });

  void it('raises integrity failure on Task Home mismatch', async () => {
    const { handler, homeVisible } = harness({
      taskSourceError: new TaskActivitySourceIntegrityError(),
    });
    await assert.rejects(
      () =>
        handler.handle(
          TX,
          event({
            eventType: TASK_COMPLETED_V1,
            homeId: OTHER_HOME,
            payload: { taskInstanceId: ENTRY },
          }),
        ),
      ActivityProjectionIntegrityError,
    );
    assert.deepEqual(homeVisible, []);
  });

  void it('raises integrity failure when Task canonical state is not completed', async () => {
    const { handler, homeVisible } = harness({
      taskSource: completedTaskSource({
        status: 'OPEN',
        completedAt: null,
        completedByMembershipId: null,
      }),
    });
    await assert.rejects(
      () =>
        handler.handle(
          TX,
          event({
            eventType: TASK_COMPLETED_V1,
            payload: { taskInstanceId: ENTRY },
          }),
        ),
      ActivityProjectionIntegrityError,
    );
    assert.deepEqual(homeVisible, []);
  });

  void it('projects obtained Supply as HOME_VISIBLE with canonical obtainer', async () => {
    const { handler, homeVisible, sourceAuthorized, uuidCalls } = harness();
    await handler.handle(
      TX,
      event({
        eventType: SUPPLY_OBTAINED_V1,
        payload: { supplyEntryId: ENTRY },
      }),
    );
    assert.equal(homeVisible.length, 1);
    assert.deepEqual(sourceAuthorized, []);
    assert.equal(uuidCalls(), 1);
    assert.deepEqual(homeVisible[0], {
      id: ACTIVITY_ID,
      homeId: HOME,
      sourceOutboxEventId: EVENT,
      sourceEntityType: 'SUPPLY',
      sourceEntityId: ENTRY,
      eventType: SUPPLY_OBTAINED_V1,
      actorMembershipId: OBTAINER,
      occurredAt: OCCURRED_AT,
      createdAt: OCCURRED_AT,
    });
    assert.notEqual(
      (homeVisible[0] as { actorMembershipId: string }).actorMembershipId,
      CREATOR,
    );
    assert.equal('title' in (homeVisible[0] as object), false);
    assert.equal('claimantMembershipId' in (homeVisible[0] as object), false);
    assert.equal('createdByMembershipId' in (homeVisible[0] as object), false);
    assert.equal('userId' in (homeVisible[0] as object), false);
  });

  void it('no-ops when the canonical Supply source is missing', async () => {
    const { handler, homeVisible, uuidCalls } = harness({ supplySource: null });
    await handler.handle(
      TX,
      event({
        eventType: SUPPLY_OBTAINED_V1,
        payload: { supplyEntryId: ENTRY },
      }),
    );
    assert.deepEqual(homeVisible, []);
    assert.equal(uuidCalls(), 0);
  });

  void it('treats duplicate Supply sourceOutboxEvent as successful replay', async () => {
    const { handler, homeVisible } = harness({
      insertResult: {
        outcome: 'duplicate_source_outbox_event',
        sourceOutboxEventId: EVENT,
      },
    });
    await handler.handle(
      TX,
      event({
        eventType: SUPPLY_OBTAINED_V1,
        payload: { supplyEntryId: ENTRY },
      }),
    );
    assert.equal(homeVisible.length, 1);
  });

  void it('raises integrity failure on Supply Home mismatch', async () => {
    const { handler, homeVisible } = harness({
      supplySourceError: new SupplyActivitySourceIntegrityError(),
    });
    await assert.rejects(
      () =>
        handler.handle(
          TX,
          event({
            eventType: SUPPLY_OBTAINED_V1,
            homeId: OTHER_HOME,
            payload: { supplyEntryId: ENTRY },
          }),
        ),
      ActivityProjectionIntegrityError,
    );
    assert.deepEqual(homeVisible, []);
  });

  void it('raises integrity failure when Supply canonical state is not obtained', async () => {
    const { handler, homeVisible } = harness({
      supplySource: obtainedSupplySource({
        status: 'OPEN',
        obtainedAt: null,
        obtainedByMembershipId: null,
      }),
    });
    await assert.rejects(
      () =>
        handler.handle(
          TX,
          event({
            eventType: SUPPLY_OBTAINED_V1,
            payload: { supplyEntryId: ENTRY },
          }),
        ),
      ActivityProjectionIntegrityError,
    );
    assert.deepEqual(homeVisible, []);
  });

  void it('projects started Membership as HOME_VISIBLE with subject-as-actor', async () => {
    const { handler, homeVisible, sourceAuthorized, uuidCalls } = harness();
    await handler.handle(
      TX,
      event({
        eventType: MEMBERSHIP_STARTED_V1,
        payload: { membershipId: SUBJECT },
      }),
    );
    assert.equal(homeVisible.length, 1);
    assert.deepEqual(sourceAuthorized, []);
    assert.equal(uuidCalls(), 1);
    assert.deepEqual(homeVisible[0], {
      id: ACTIVITY_ID,
      homeId: HOME,
      sourceOutboxEventId: EVENT,
      sourceEntityType: 'MEMBERSHIP',
      sourceEntityId: SUBJECT,
      eventType: MEMBERSHIP_STARTED_V1,
      actorMembershipId: SUBJECT,
      occurredAt: OCCURRED_AT,
      createdAt: OCCURRED_AT,
    });
  });

  void it('still projects started Membership after the source has ended', async () => {
    const { handler, homeVisible } = harness();
    await handler.handle(
      TX,
      event({
        eventType: MEMBERSHIP_STARTED_V1,
        payload: { membershipId: SUBJECT },
      }),
    );
    assert.equal(homeVisible.length, 1);
    assert.equal(
      (homeVisible[0] as { actorMembershipId: string }).actorMembershipId,
      SUBJECT,
    );
  });

  void it('no-ops when the canonical started Membership source is missing', async () => {
    const { handler, homeVisible, uuidCalls } = harness({
      startedSource: null,
    });
    await handler.handle(
      TX,
      event({
        eventType: MEMBERSHIP_STARTED_V1,
        payload: { membershipId: SUBJECT },
      }),
    );
    assert.deepEqual(homeVisible, []);
    assert.equal(uuidCalls(), 0);
  });

  void it('raises integrity failure on started Membership Home mismatch', async () => {
    const { handler, homeVisible } = harness({
      startedSourceError: new MembershipActivitySourceIntegrityError(),
    });
    await assert.rejects(
      () =>
        handler.handle(
          TX,
          event({
            eventType: MEMBERSHIP_STARTED_V1,
            homeId: OTHER_HOME,
            payload: { membershipId: SUBJECT },
          }),
        ),
      ActivityProjectionIntegrityError,
    );
    assert.deepEqual(homeVisible, []);
  });

  void it('projects ended Membership with canonical endedBy actor', async () => {
    const { handler, homeVisible, sourceAuthorized } = harness();
    await handler.handle(
      TX,
      event({
        eventType: MEMBERSHIP_ENDED_V1,
        payload: { membershipId: SUBJECT },
      }),
    );
    assert.equal(homeVisible.length, 1);
    assert.deepEqual(sourceAuthorized, []);
    assert.deepEqual(homeVisible[0], {
      id: ACTIVITY_ID,
      homeId: HOME,
      sourceOutboxEventId: EVENT,
      sourceEntityType: 'MEMBERSHIP',
      sourceEntityId: SUBJECT,
      eventType: MEMBERSHIP_ENDED_V1,
      actorMembershipId: ACTOR,
      occurredAt: OCCURRED_AT,
      createdAt: OCCURRED_AT,
    });
    assert.notEqual(ACTOR, SUBJECT);
  });

  void it('raises integrity failure when ended attribution is null', async () => {
    const { handler, homeVisible } = harness({
      endedSource: endedMembershipSource({
        endedAt: OCCURRED_AT,
        endedByMembershipId: null,
      }),
    });
    await assert.rejects(
      () =>
        handler.handle(
          TX,
          event({
            eventType: MEMBERSHIP_ENDED_V1,
            payload: { membershipId: SUBJECT },
          }),
        ),
      ActivityProjectionIntegrityError,
    );
    assert.deepEqual(homeVisible, []);
  });

  void it('no-ops when the canonical ended Membership source is missing', async () => {
    const { handler, homeVisible, uuidCalls } = harness({ endedSource: null });
    await handler.handle(
      TX,
      event({
        eventType: MEMBERSHIP_ENDED_V1,
        payload: { membershipId: SUBJECT },
      }),
    );
    assert.deepEqual(homeVisible, []);
    assert.equal(uuidCalls(), 0);
  });

  void it('raises integrity failure on ended Membership Home mismatch', async () => {
    const { handler, homeVisible } = harness({
      endedSourceError: new MembershipActivitySourceIntegrityError(),
    });
    await assert.rejects(
      () =>
        handler.handle(
          TX,
          event({
            eventType: MEMBERSHIP_ENDED_V1,
            homeId: OTHER_HOME,
            payload: { membershipId: SUBJECT },
          }),
        ),
      ActivityProjectionIntegrityError,
    );
    assert.deepEqual(homeVisible, []);
  });

  void it('projects role change from the exact transition actor', async () => {
    const { handler, homeVisible, sourceAuthorized } = harness();
    await handler.handle(
      TX,
      event({
        eventType: MEMBERSHIP_ROLE_CHANGED_V1,
        payload: { membershipId: SUBJECT, roleTransitionId: TRANSITION },
      }),
    );
    assert.equal(homeVisible.length, 1);
    assert.deepEqual(sourceAuthorized, []);
    assert.deepEqual(homeVisible[0], {
      id: ACTIVITY_ID,
      homeId: HOME,
      sourceOutboxEventId: EVENT,
      sourceEntityType: 'MEMBERSHIP',
      sourceEntityId: SUBJECT,
      eventType: MEMBERSHIP_ROLE_CHANGED_V1,
      actorMembershipId: ACTOR,
      occurredAt: OCCURRED_AT,
      createdAt: OCCURRED_AT,
    });
    assert.notEqual(ACTOR, SUBJECT);
  });

  void it('no-ops when the canonical role transition is missing', async () => {
    const { handler, homeVisible, uuidCalls } = harness({ roleSource: null });
    await handler.handle(
      TX,
      event({
        eventType: MEMBERSHIP_ROLE_CHANGED_V1,
        payload: { membershipId: SUBJECT, roleTransitionId: TRANSITION },
      }),
    );
    assert.deepEqual(homeVisible, []);
    assert.equal(uuidCalls(), 0);
  });

  void it('raises integrity failure on role transition Home or subject mismatch', async () => {
    const { handler, homeVisible } = harness({
      roleSourceError: new MembershipActivitySourceIntegrityError(),
    });
    await assert.rejects(
      () =>
        handler.handle(
          TX,
          event({
            eventType: MEMBERSHIP_ROLE_CHANGED_V1,
            homeId: OTHER_HOME,
            payload: { membershipId: SUBJECT, roleTransitionId: TRANSITION },
          }),
        ),
      ActivityProjectionIntegrityError,
    );
    assert.deepEqual(homeVisible, []);
  });

  void it('treats duplicate Membership sourceOutboxEvent as successful replay', async () => {
    const { handler, homeVisible } = harness({
      insertResult: {
        outcome: 'duplicate_source_outbox_event',
        sourceOutboxEventId: EVENT,
      },
    });
    await handler.handle(
      TX,
      event({
        eventType: MEMBERSHIP_STARTED_V1,
        payload: { membershipId: SUBJECT },
      }),
    );
    assert.equal(homeVisible.length, 1);
  });
});
