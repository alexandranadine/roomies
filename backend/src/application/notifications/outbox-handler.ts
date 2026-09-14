import {
  lockHomeAndExactMemberships,
  type LockedHomeAndExactMemberships,
} from '../../domains/homes/lock-home-and-exact-memberships.js';
import {
  MAINTENANCE_CREATED_V1,
  MAINTENANCE_RESOLVED_V1,
} from '../../domains/maintenance/events.js';
import { MaintenanceNotificationSourceIntegrityError } from '../../domains/maintenance/errors.js';
import {
  findMaintenanceNotificationSource,
  type FindMaintenanceNotificationSource,
} from '../../domains/maintenance/find-maintenance-notification-source.js';
import { MEMBERSHIP_ROLE_CHANGED_V1 } from '../../domains/memberships/events.js';
import { MembershipNotificationSourceIntegrityError } from '../../domains/memberships/errors.js';
import {
  findMembershipRoleTransitionNotificationSource,
  type FindMembershipRoleTransitionNotificationSource,
} from '../../domains/memberships/find-membership-notification-source.js';
import type {
  NewNotification,
  NotificationInsertResult,
} from '../../domains/notifications/repository.js';
import type {
  NotificationKind,
  NotificationSourceEntityType,
} from '../../domains/notifications/notification.js';
import { SUPPLY_OBTAINED_V1 } from '../../domains/supplies/events.js';
import { SupplyNotificationSourceIntegrityError } from '../../domains/supplies/errors.js';
import {
  findSupplyNotificationSource,
  type FindSupplyNotificationSource,
} from '../../domains/supplies/find-supply-notification-source.js';
import { TASK_COMPLETED_V1 } from '../../domains/tasks/events.js';
import { TaskNotificationSourceIntegrityError } from '../../domains/tasks/errors.js';
import {
  findTaskNotificationSource,
  type FindTaskNotificationSource,
} from '../../domains/tasks/find-task-notification-source.js';
import { ConcealedNotFoundError } from '../../platform/authz/index.js';
import type { JsonObject } from '../../platform/events/outbox-types.js';
import type { UuidV7Generator } from '../../platform/ids/uuid-v7.js';
import { systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import type { OutboxEventHandler } from '../../platform/outbox/handler.js';
import type { OutboxEvent } from '../../platform/outbox/outbox-event.js';
import type {
  TransactionContext,
  TransactionPool,
} from '../../platform/persistence/transaction.js';
import { NotificationProjectionIntegrityError } from './errors.js';
import {
  createNotificationPersistenceFromPool,
  type NotificationPersistence,
} from './notification-persistence.js';

export const NOTIFICATIONS_OUTBOX_HANDLER_ID = 'notifications';

export const NOTIFICATIONS_OUTBOX_EVENT_TYPES = [
  MEMBERSHIP_ROLE_CHANGED_V1,
  TASK_COMPLETED_V1,
  SUPPLY_OBTAINED_V1,
  MAINTENANCE_CREATED_V1,
  MAINTENANCE_RESOLVED_V1,
] as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type LockHomeAndExactMemberships = (
  tx: TransactionContext,
  input: Readonly<{ homeId: string; membershipIds: readonly string[] }>,
) => Promise<LockedHomeAndExactMemberships>;

export type NotificationOutboxHandlerDependencies = Readonly<{
  findMembershipRoleTransitionSource: FindMembershipRoleTransitionNotificationSource;
  findTaskSource: FindTaskNotificationSource;
  findSupplySource: FindSupplyNotificationSource;
  findMaintenanceSource: FindMaintenanceNotificationSource;
  lockHomeAndExactMemberships: LockHomeAndExactMemberships;
  notifications: NotificationPersistence;
  ids: UuidV7Generator;
}>;

type NotificationPlan = Readonly<{
  homeId: string;
  kind: NotificationKind;
  sourceEntityType: NotificationSourceEntityType;
  sourceEntityId: string;
  actorMembershipId: string;
  candidateMembershipIds: readonly string[];
}>;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function payloadUuid(payload: JsonObject, key: string): string {
  const value = payload[key];
  if (!isUuid(value)) {
    throw new NotificationProjectionIntegrityError();
  }
  return value;
}

function requireHomeId(event: OutboxEvent): string {
  if (!isUuid(event.homeId)) {
    throw new NotificationProjectionIntegrityError();
  }
  return event.homeId;
}

function sameTime(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

function isSourceIntegrityError(error: unknown): boolean {
  return (
    error instanceof MembershipNotificationSourceIntegrityError ||
    error instanceof TaskNotificationSourceIntegrityError ||
    error instanceof SupplyNotificationSourceIntegrityError ||
    error instanceof MaintenanceNotificationSourceIntegrityError
  );
}

async function roleChangedPlan(
  tx: TransactionContext,
  event: OutboxEvent,
  deps: NotificationOutboxHandlerDependencies,
): Promise<NotificationPlan | null> {
  const homeId = requireHomeId(event);
  const membershipId = payloadUuid(event.payload, 'membershipId');
  const roleTransitionId = payloadUuid(event.payload, 'roleTransitionId');
  const source = await deps.findMembershipRoleTransitionSource(tx, {
    roleTransitionId,
    membershipId,
    expectedHomeId: homeId,
  });
  if (source === null) {
    return null;
  }
  if (
    source.transitionId !== roleTransitionId ||
    source.homeId !== homeId ||
    source.membershipId !== membershipId ||
    !sameTime(source.changedAt, event.occurredAt)
  ) {
    throw new NotificationProjectionIntegrityError();
  }
  return Object.freeze({
    homeId,
    kind: 'MEMBERSHIP_ROLE_CHANGED',
    sourceEntityType: 'MEMBERSHIP',
    sourceEntityId: membershipId,
    actorMembershipId: source.actorMembershipId,
    candidateMembershipIds:
      source.actorMembershipId === membershipId
        ? Object.freeze([])
        : Object.freeze([membershipId]),
  });
}

async function taskCompletedPlan(
  tx: TransactionContext,
  event: OutboxEvent,
  deps: NotificationOutboxHandlerDependencies,
): Promise<NotificationPlan | null> {
  const homeId = requireHomeId(event);
  const taskInstanceId = payloadUuid(event.payload, 'taskInstanceId');
  const source = await deps.findTaskSource(tx, {
    taskInstanceId,
    expectedHomeId: homeId,
  });
  if (source === null) {
    return null;
  }
  if (
    source.id !== taskInstanceId ||
    source.homeId !== homeId ||
    source.status !== 'COMPLETED' ||
    source.completedAt === null ||
    source.completedByMembershipId === null ||
    !sameTime(source.completedAt, event.occurredAt)
  ) {
    throw new NotificationProjectionIntegrityError();
  }
  const assignee = source.assignedMembershipId;
  return Object.freeze({
    homeId,
    kind: 'ASSIGNED_TASK_COMPLETED',
    sourceEntityType: 'TASK',
    sourceEntityId: source.id,
    actorMembershipId: source.completedByMembershipId,
    candidateMembershipIds:
      assignee === null || assignee === source.completedByMembershipId
        ? Object.freeze([])
        : Object.freeze([assignee]),
  });
}

async function supplyObtainedPlan(
  tx: TransactionContext,
  event: OutboxEvent,
  deps: NotificationOutboxHandlerDependencies,
): Promise<NotificationPlan | null> {
  const homeId = requireHomeId(event);
  const supplyEntryId = payloadUuid(event.payload, 'supplyEntryId');
  const source = await deps.findSupplySource(tx, {
    supplyEntryId,
    expectedHomeId: homeId,
  });
  if (source === null) {
    return null;
  }
  if (
    source.id !== supplyEntryId ||
    source.homeId !== homeId ||
    source.status !== 'OBTAINED' ||
    source.obtainedAt === null ||
    source.obtainedByMembershipId === null ||
    !sameTime(source.obtainedAt, event.occurredAt)
  ) {
    throw new NotificationProjectionIntegrityError();
  }
  return Object.freeze({
    homeId,
    kind: 'CREATED_SUPPLY_OBTAINED',
    sourceEntityType: 'SUPPLY',
    sourceEntityId: source.id,
    actorMembershipId: source.obtainedByMembershipId,
    candidateMembershipIds:
      source.createdByMembershipId === source.obtainedByMembershipId
        ? Object.freeze([])
        : Object.freeze([source.createdByMembershipId]),
  });
}

async function maintenancePlan(
  tx: TransactionContext,
  event: OutboxEvent,
  deps: NotificationOutboxHandlerDependencies,
): Promise<NotificationPlan | null> {
  const homeId = requireHomeId(event);
  const maintenanceEntryId = payloadUuid(event.payload, 'maintenanceEntryId');
  const source = await deps.findMaintenanceSource(tx, {
    maintenanceEntryId,
    expectedHomeId: homeId,
  });
  if (source === null || source.visibility === 'HOUSEHOLD') {
    return null;
  }
  if (source.id !== maintenanceEntryId || source.homeId !== homeId) {
    throw new NotificationProjectionIntegrityError();
  }

  let kind: NotificationKind;
  let actorMembershipId: string;
  if (event.eventType === MAINTENANCE_CREATED_V1) {
    if (!sameTime(source.createdAt, event.occurredAt)) {
      throw new NotificationProjectionIntegrityError();
    }
    kind = 'PRIVATE_MAINTENANCE_CREATED';
    actorMembershipId = source.createdByMembershipId;
  } else if (event.eventType === MAINTENANCE_RESOLVED_V1) {
    if (
      source.status !== 'RESOLVED' ||
      source.resolvedAt === null ||
      source.resolvedByMembershipId === null ||
      !sameTime(source.resolvedAt, event.occurredAt)
    ) {
      throw new NotificationProjectionIntegrityError();
    }
    kind = 'PRIVATE_MAINTENANCE_RESOLVED';
    actorMembershipId = source.resolvedByMembershipId;
  } else {
    throw new NotificationProjectionIntegrityError();
  }

  return Object.freeze({
    homeId,
    kind,
    sourceEntityType: 'MAINTENANCE',
    sourceEntityId: source.id,
    actorMembershipId,
    candidateMembershipIds: Object.freeze(
      source.recipientMembershipIds.filter(
        (membershipId) => membershipId !== actorMembershipId,
      ),
    ),
  });
}

async function planFor(
  tx: TransactionContext,
  event: OutboxEvent,
  deps: NotificationOutboxHandlerDependencies,
): Promise<NotificationPlan | null> {
  try {
    if (event.eventType === MEMBERSHIP_ROLE_CHANGED_V1) {
      return await roleChangedPlan(tx, event, deps);
    }
    if (event.eventType === TASK_COMPLETED_V1) {
      return await taskCompletedPlan(tx, event, deps);
    }
    if (event.eventType === SUPPLY_OBTAINED_V1) {
      return await supplyObtainedPlan(tx, event, deps);
    }
    if (
      event.eventType === MAINTENANCE_CREATED_V1 ||
      event.eventType === MAINTENANCE_RESOLVED_V1
    ) {
      return await maintenancePlan(tx, event, deps);
    }
  } catch (error) {
    if (isSourceIntegrityError(error)) {
      throw new NotificationProjectionIntegrityError();
    }
    throw error;
  }
  throw new NotificationProjectionIntegrityError();
}

async function eligibleMembershipIds(
  tx: TransactionContext,
  plan: NotificationPlan,
  deps: NotificationOutboxHandlerDependencies,
): Promise<readonly string[] | null> {
  let locked: LockedHomeAndExactMemberships;
  try {
    locked = await deps.lockHomeAndExactMemberships(tx, {
      homeId: plan.homeId,
      membershipIds: plan.candidateMembershipIds,
    });
  } catch (error) {
    if (error instanceof ConcealedNotFoundError) {
      return null;
    }
    throw error;
  }

  const byId = new Map(
    locked.memberships.map((membership) => [membership.id, membership]),
  );
  const eligible: string[] = [];
  for (const membershipId of [...new Set(plan.candidateMembershipIds)].sort()) {
    const membership = byId.get(membershipId);
    if (membership === undefined) {
      continue;
    }
    if (membership.homeId !== plan.homeId) {
      throw new NotificationProjectionIntegrityError();
    }
    if (membership.endedAt === null) {
      eligible.push(membershipId);
    }
  }
  return Object.freeze(eligible);
}

function matchesExisting(
  expected: NewNotification,
  result: NotificationInsertResult,
  existing: Awaited<
    ReturnType<NotificationPersistence['findBySourceRecipientKind']>
  >,
): boolean {
  return (
    result.outcome === 'duplicate_source_recipient_kind' &&
    existing !== null &&
    existing.homeId === expected.homeId &&
    existing.recipientMembershipId === expected.recipientMembershipId &&
    existing.sourceOutboxEventId === expected.sourceOutboxEventId &&
    existing.kind === expected.kind &&
    existing.sourceEntityType === expected.sourceEntityType &&
    existing.sourceEntityId === expected.sourceEntityId &&
    existing.actorMembershipId === expected.actorMembershipId &&
    sameTime(existing.occurredAt, expected.occurredAt)
  );
}

async function insertPlan(
  tx: TransactionContext,
  event: OutboxEvent,
  plan: NotificationPlan,
  deps: NotificationOutboxHandlerDependencies,
): Promise<void> {
  const recipients = await eligibleMembershipIds(tx, plan, deps);
  if (recipients === null || recipients.length === 0) {
    return;
  }
  const rows: NewNotification[] = recipients.map((recipientMembershipId) =>
    Object.freeze({
      id: deps.ids.next(),
      homeId: plan.homeId,
      recipientMembershipId,
      sourceOutboxEventId: event.eventId,
      kind: plan.kind,
      sourceEntityType: plan.sourceEntityType,
      sourceEntityId: plan.sourceEntityId,
      actorMembershipId: plan.actorMembershipId,
      occurredAt: event.occurredAt,
      createdAt: event.occurredAt,
      readAt: null,
    }),
  );
  const results = await deps.notifications.insertNotifications(tx, rows);
  if (results.length !== rows.length) {
    throw new NotificationProjectionIntegrityError();
  }

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const expected = rows[index];
    if (result === undefined || expected === undefined) {
      throw new NotificationProjectionIntegrityError();
    }
    if (result.outcome === 'inserted') {
      continue;
    }
    const existing = await deps.notifications.findBySourceRecipientKind(tx, {
      sourceOutboxEventId: expected.sourceOutboxEventId,
      recipientMembershipId: expected.recipientMembershipId,
      kind: expected.kind,
    });
    if (!matchesExisting(expected, result, existing)) {
      throw new NotificationProjectionIntegrityError();
    }
  }
}

/**
 * Notification participant in the deployed global outbox dispatcher. It uses
 * only the caller transaction and never checkpoints independently.
 */
export function createNotificationOutboxHandler(
  deps: NotificationOutboxHandlerDependencies,
): OutboxEventHandler {
  return Object.freeze({
    handlerId: NOTIFICATIONS_OUTBOX_HANDLER_ID,
    eventTypes: NOTIFICATIONS_OUTBOX_EVENT_TYPES,
    async handle(tx, event) {
      const plan = await planFor(tx, event, deps);
      if (plan !== null) {
        await insertPlan(tx, event, plan, deps);
      }
    },
  });
}

export function createNotificationOutboxHandlerFromPool(
  pool: TransactionPool,
): OutboxEventHandler {
  return createNotificationOutboxHandler({
    findMembershipRoleTransitionSource:
      findMembershipRoleTransitionNotificationSource,
    findTaskSource: findTaskNotificationSource,
    findSupplySource: findSupplyNotificationSource,
    findMaintenanceSource: findMaintenanceNotificationSource,
    lockHomeAndExactMemberships,
    notifications: createNotificationPersistenceFromPool(pool),
    ids: systemUuidV7,
  });
}
