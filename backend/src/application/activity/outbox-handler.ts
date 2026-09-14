import {
  createActivityRepository,
  type ActivityRepository,
  type NewActivity,
} from '../../domains/activity/repository.js';
import {
  MAINTENANCE_CREATED_V1,
  MAINTENANCE_RESOLVED_V1,
} from '../../domains/maintenance/events.js';
import { MaintenanceActivitySourceIntegrityError } from '../../domains/maintenance/errors.js';
import {
  findMaintenanceActivitySource,
  type FindMaintenanceActivitySource,
  type MaintenanceActivitySource,
} from '../../domains/maintenance/find-maintenance-activity-source.js';
import { SupplyActivitySourceIntegrityError } from '../../domains/supplies/errors.js';
import { SUPPLY_OBTAINED_V1 } from '../../domains/supplies/events.js';
import {
  findSupplyActivitySource,
  type FindSupplyActivitySource,
  type SupplyActivitySource,
} from '../../domains/supplies/find-supply-activity-source.js';
import { MembershipActivitySourceIntegrityError } from '../../domains/memberships/errors.js';
import {
  MEMBERSHIP_ENDED_V1,
  MEMBERSHIP_ROLE_CHANGED_V1,
  MEMBERSHIP_STARTED_V1,
} from '../../domains/memberships/events.js';
import {
  findMembershipEndedActivitySource,
  findMembershipRoleTransitionActivitySource,
  findMembershipStartedActivitySource,
  type FindMembershipEndedActivitySource,
  type FindMembershipRoleTransitionActivitySource,
  type FindMembershipStartedActivitySource,
  type MembershipEndedActivitySource,
  type MembershipRoleTransitionActivitySource,
  type MembershipStartedActivitySource,
} from '../../domains/memberships/find-membership-activity-source.js';
import { TaskActivitySourceIntegrityError } from '../../domains/tasks/errors.js';
import { TASK_COMPLETED_V1 } from '../../domains/tasks/events.js';
import {
  findTaskActivitySource,
  type FindTaskActivitySource,
  type TaskActivitySource,
} from '../../domains/tasks/find-task-activity-source.js';
import type { JsonObject } from '../../platform/events/outbox-types.js';
import type { UuidV7Generator } from '../../platform/ids/uuid-v7.js';
import { systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import type { OutboxEventHandler } from '../../platform/outbox/handler.js';
import type { OutboxEvent } from '../../platform/outbox/outbox-event.js';
import type {
  TransactionContext,
  TransactionPool,
} from '../../platform/persistence/transaction.js';
import { ActivityProjectionIntegrityError } from './errors.js';

export const ACTIVITY_OUTBOX_HANDLER_ID = 'activity';

export const ACTIVITY_OUTBOX_EVENT_TYPES = [
  MAINTENANCE_CREATED_V1,
  MAINTENANCE_RESOLVED_V1,
  TASK_COMPLETED_V1,
  SUPPLY_OBTAINED_V1,
  MEMBERSHIP_STARTED_V1,
  MEMBERSHIP_ENDED_V1,
  MEMBERSHIP_ROLE_CHANGED_V1,
] as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ActivityOutboxHandlerDependencies = Readonly<{
  findMaintenanceActivitySource: FindMaintenanceActivitySource;
  findTaskActivitySource: FindTaskActivitySource;
  findSupplyActivitySource: FindSupplyActivitySource;
  findMembershipStartedActivitySource: FindMembershipStartedActivitySource;
  findMembershipEndedActivitySource: FindMembershipEndedActivitySource;
  findMembershipRoleTransitionActivitySource: FindMembershipRoleTransitionActivitySource;
  activity: Pick<
    ActivityRepository,
    'insertHomeVisibleActivity' | 'insertSourceAuthorizedActivity'
  >;
  ids: UuidV7Generator;
}>;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function uuidFromPayload(payload: JsonObject, key: string): string {
  const value = payload[key];
  if (!isUuid(value)) {
    throw new ActivityProjectionIntegrityError();
  }
  return value;
}

function sameOccurrenceTime(eventAt: Date, canonicalAt: Date): boolean {
  return eventAt.getTime() === canonicalAt.getTime();
}

function actorMembershipIdForMaintenanceEvent(
  eventType: string,
  source: MaintenanceActivitySource,
): string {
  if (eventType === MAINTENANCE_CREATED_V1) {
    return source.createdByMembershipId;
  }
  if (eventType === MAINTENANCE_RESOLVED_V1) {
    if (
      source.status !== 'RESOLVED' ||
      source.resolvedByMembershipId === null ||
      source.resolvedAt === null
    ) {
      throw new ActivityProjectionIntegrityError();
    }
    return source.resolvedByMembershipId;
  }
  throw new ActivityProjectionIntegrityError();
}

function newMaintenanceActivity(
  event: OutboxEvent,
  source: MaintenanceActivitySource,
  actorMembershipId: string,
  activityId: string,
): NewActivity {
  return Object.freeze({
    id: activityId,
    homeId: source.homeId,
    sourceOutboxEventId: event.eventId,
    sourceEntityType: 'MAINTENANCE',
    sourceEntityId: source.id,
    eventType: event.eventType,
    actorMembershipId,
    occurredAt: event.occurredAt,
    createdAt: event.occurredAt,
  });
}

async function projectMaintenanceActivity(
  tx: TransactionContext,
  event: OutboxEvent,
  deps: ActivityOutboxHandlerDependencies,
): Promise<void> {
  if (event.homeId === null || !isUuid(event.homeId)) {
    throw new ActivityProjectionIntegrityError();
  }

  const maintenanceEntryId = uuidFromPayload(
    event.payload,
    'maintenanceEntryId',
  );
  let source: MaintenanceActivitySource | null;
  try {
    source = await deps.findMaintenanceActivitySource(tx, {
      maintenanceEntryId,
      expectedHomeId: event.homeId,
    });
  } catch (error) {
    if (error instanceof MaintenanceActivitySourceIntegrityError) {
      throw new ActivityProjectionIntegrityError();
    }
    throw error;
  }

  if (source === null) {
    return;
  }

  const actorMembershipId = actorMembershipIdForMaintenanceEvent(
    event.eventType,
    source,
  );
  const activity = newMaintenanceActivity(
    event,
    source,
    actorMembershipId,
    deps.ids.next(),
  );

  const inserted =
    source.visibility === 'HOUSEHOLD'
      ? await deps.activity.insertHomeVisibleActivity(tx, activity)
      : await deps.activity.insertSourceAuthorizedActivity(
          tx,
          activity,
          source.audienceMembershipIds,
        );

  if (inserted.outcome === 'duplicate_source_outbox_event') {
    return;
  }
}

async function projectTaskCompletedActivity(
  tx: TransactionContext,
  event: OutboxEvent,
  deps: ActivityOutboxHandlerDependencies,
): Promise<void> {
  if (event.homeId === null || !isUuid(event.homeId)) {
    throw new ActivityProjectionIntegrityError();
  }

  const taskInstanceId = uuidFromPayload(event.payload, 'taskInstanceId');
  let source: TaskActivitySource | null;
  try {
    source = await deps.findTaskActivitySource(tx, {
      taskInstanceId,
      expectedHomeId: event.homeId,
    });
  } catch (error) {
    if (error instanceof TaskActivitySourceIntegrityError) {
      throw new ActivityProjectionIntegrityError();
    }
    throw error;
  }

  if (source === null) {
    return;
  }

  if (
    source.status !== 'COMPLETED' ||
    source.completedAt === null ||
    source.completedByMembershipId === null
  ) {
    throw new ActivityProjectionIntegrityError();
  }

  const activity: NewActivity = Object.freeze({
    id: deps.ids.next(),
    homeId: source.homeId,
    sourceOutboxEventId: event.eventId,
    sourceEntityType: 'TASK',
    sourceEntityId: source.id,
    eventType: event.eventType,
    actorMembershipId: source.completedByMembershipId,
    occurredAt: event.occurredAt,
    createdAt: event.occurredAt,
  });

  const inserted = await deps.activity.insertHomeVisibleActivity(tx, activity);
  if (inserted.outcome === 'duplicate_source_outbox_event') {
    return;
  }
}

async function projectSupplyObtainedActivity(
  tx: TransactionContext,
  event: OutboxEvent,
  deps: ActivityOutboxHandlerDependencies,
): Promise<void> {
  if (event.homeId === null || !isUuid(event.homeId)) {
    throw new ActivityProjectionIntegrityError();
  }

  const supplyEntryId = uuidFromPayload(event.payload, 'supplyEntryId');
  let source: SupplyActivitySource | null;
  try {
    source = await deps.findSupplyActivitySource(tx, {
      supplyEntryId,
      expectedHomeId: event.homeId,
    });
  } catch (error) {
    if (error instanceof SupplyActivitySourceIntegrityError) {
      throw new ActivityProjectionIntegrityError();
    }
    throw error;
  }

  if (source === null) {
    return;
  }

  if (
    source.status !== 'OBTAINED' ||
    source.obtainedAt === null ||
    source.obtainedByMembershipId === null
  ) {
    throw new ActivityProjectionIntegrityError();
  }

  const activity: NewActivity = Object.freeze({
    id: deps.ids.next(),
    homeId: source.homeId,
    sourceOutboxEventId: event.eventId,
    sourceEntityType: 'SUPPLY',
    sourceEntityId: source.id,
    eventType: event.eventType,
    actorMembershipId: source.obtainedByMembershipId,
    occurredAt: event.occurredAt,
    createdAt: event.occurredAt,
  });

  const inserted = await deps.activity.insertHomeVisibleActivity(tx, activity);
  if (inserted.outcome === 'duplicate_source_outbox_event') {
    return;
  }
}

async function insertMembershipHomeVisibleActivity(
  tx: TransactionContext,
  event: OutboxEvent,
  input: Readonly<{
    homeId: string;
    sourceEntityId: string;
    actorMembershipId: string;
  }>,
  deps: ActivityOutboxHandlerDependencies,
): Promise<void> {
  const activity: NewActivity = Object.freeze({
    id: deps.ids.next(),
    homeId: input.homeId,
    sourceOutboxEventId: event.eventId,
    sourceEntityType: 'MEMBERSHIP',
    sourceEntityId: input.sourceEntityId,
    eventType: event.eventType,
    actorMembershipId: input.actorMembershipId,
    occurredAt: event.occurredAt,
    createdAt: event.occurredAt,
  });

  const inserted = await deps.activity.insertHomeVisibleActivity(tx, activity);
  if (inserted.outcome === 'duplicate_source_outbox_event') {
    return;
  }
}

async function projectMembershipStartedActivity(
  tx: TransactionContext,
  event: OutboxEvent,
  deps: ActivityOutboxHandlerDependencies,
): Promise<void> {
  if (event.homeId === null || !isUuid(event.homeId)) {
    throw new ActivityProjectionIntegrityError();
  }

  const membershipId = uuidFromPayload(event.payload, 'membershipId');
  let source: MembershipStartedActivitySource | null;
  try {
    source = await deps.findMembershipStartedActivitySource(tx, {
      membershipId,
      expectedHomeId: event.homeId,
    });
  } catch (error) {
    if (error instanceof MembershipActivitySourceIntegrityError) {
      throw new ActivityProjectionIntegrityError();
    }
    throw error;
  }

  if (source === null) {
    return;
  }

  if (
    source.membershipId !== membershipId ||
    source.homeId !== event.homeId ||
    !sameOccurrenceTime(event.occurredAt, source.joinedAt)
  ) {
    throw new ActivityProjectionIntegrityError();
  }

  await insertMembershipHomeVisibleActivity(
    tx,
    event,
    {
      homeId: source.homeId,
      sourceEntityId: source.membershipId,
      actorMembershipId: source.membershipId,
    },
    deps,
  );
}

async function projectMembershipEndedActivity(
  tx: TransactionContext,
  event: OutboxEvent,
  deps: ActivityOutboxHandlerDependencies,
): Promise<void> {
  if (event.homeId === null || !isUuid(event.homeId)) {
    throw new ActivityProjectionIntegrityError();
  }

  const membershipId = uuidFromPayload(event.payload, 'membershipId');
  let source: MembershipEndedActivitySource | null;
  try {
    source = await deps.findMembershipEndedActivitySource(tx, {
      membershipId,
      expectedHomeId: event.homeId,
    });
  } catch (error) {
    if (error instanceof MembershipActivitySourceIntegrityError) {
      throw new ActivityProjectionIntegrityError();
    }
    throw error;
  }

  if (source === null) {
    return;
  }

  if (
    source.membershipId !== membershipId ||
    source.homeId !== event.homeId ||
    source.endedAt === null ||
    source.endedByMembershipId === null ||
    !sameOccurrenceTime(event.occurredAt, source.endedAt)
  ) {
    throw new ActivityProjectionIntegrityError();
  }

  await insertMembershipHomeVisibleActivity(
    tx,
    event,
    {
      homeId: source.homeId,
      sourceEntityId: source.membershipId,
      actorMembershipId: source.endedByMembershipId,
    },
    deps,
  );
}

async function projectMembershipRoleChangedActivity(
  tx: TransactionContext,
  event: OutboxEvent,
  deps: ActivityOutboxHandlerDependencies,
): Promise<void> {
  if (event.homeId === null || !isUuid(event.homeId)) {
    throw new ActivityProjectionIntegrityError();
  }

  const membershipId = uuidFromPayload(event.payload, 'membershipId');
  const roleTransitionId = uuidFromPayload(event.payload, 'roleTransitionId');
  let source: MembershipRoleTransitionActivitySource | null;
  try {
    source = await deps.findMembershipRoleTransitionActivitySource(tx, {
      roleTransitionId,
      membershipId,
      expectedHomeId: event.homeId,
    });
  } catch (error) {
    if (error instanceof MembershipActivitySourceIntegrityError) {
      throw new ActivityProjectionIntegrityError();
    }
    throw error;
  }

  if (source === null) {
    return;
  }

  if (
    source.transitionId !== roleTransitionId ||
    source.homeId !== event.homeId ||
    source.membershipId !== membershipId ||
    !sameOccurrenceTime(event.occurredAt, source.changedAt)
  ) {
    throw new ActivityProjectionIntegrityError();
  }

  await insertMembershipHomeVisibleActivity(
    tx,
    event,
    {
      homeId: source.homeId,
      sourceEntityId: source.membershipId,
      actorMembershipId: source.actorMembershipId,
    },
    deps,
  );
}

/**
 * Activity outbox handler. Uses the caller transaction only. Membership
 * structural events share this same identity.
 */
export function createActivityOutboxHandler(
  deps: ActivityOutboxHandlerDependencies,
): OutboxEventHandler {
  return Object.freeze({
    handlerId: ACTIVITY_OUTBOX_HANDLER_ID,
    eventTypes: ACTIVITY_OUTBOX_EVENT_TYPES,
    async handle(tx, event) {
      if (
        event.eventType === MAINTENANCE_CREATED_V1 ||
        event.eventType === MAINTENANCE_RESOLVED_V1
      ) {
        await projectMaintenanceActivity(tx, event, deps);
        return;
      }
      if (event.eventType === TASK_COMPLETED_V1) {
        await projectTaskCompletedActivity(tx, event, deps);
        return;
      }
      if (event.eventType === SUPPLY_OBTAINED_V1) {
        await projectSupplyObtainedActivity(tx, event, deps);
        return;
      }
      if (event.eventType === MEMBERSHIP_STARTED_V1) {
        await projectMembershipStartedActivity(tx, event, deps);
        return;
      }
      if (event.eventType === MEMBERSHIP_ENDED_V1) {
        await projectMembershipEndedActivity(tx, event, deps);
        return;
      }
      if (event.eventType === MEMBERSHIP_ROLE_CHANGED_V1) {
        await projectMembershipRoleChangedActivity(tx, event, deps);
        return;
      }
      throw new ActivityProjectionIntegrityError();
    },
  });
}

export function createActivityOutboxHandlerFromPool(
  pool: TransactionPool,
): OutboxEventHandler {
  return createActivityOutboxHandler({
    findMaintenanceActivitySource,
    findTaskActivitySource,
    findSupplyActivitySource,
    findMembershipStartedActivitySource,
    findMembershipEndedActivitySource,
    findMembershipRoleTransitionActivitySource,
    activity: createActivityRepository(
      pool as Parameters<typeof createActivityRepository>[0],
    ),
    ids: systemUuidV7,
  });
}
