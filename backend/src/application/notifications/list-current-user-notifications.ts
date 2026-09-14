import { decideNotificationList } from '../../domains/notifications/list-policy.js';
import { NOTIFICATION_LIST_DEFAULT_LIMIT } from '../../domains/notifications/cursor.js';
import { InvalidNotificationRequestError } from '../../domains/notifications/errors.js';
import type {
  EligibleNotification,
  NotificationDestination,
  NotificationListItem,
  NotificationListPage,
  NotificationRepositoryPage,
  NotificationSourcePresentation,
} from '../../domains/notifications/notification-list-item.js';
import {
  createNotificationRepository,
  type NotificationRepository,
} from '../../domains/notifications/repository.js';
import { MembershipActivitySourceIntegrityError } from '../../domains/memberships/errors.js';
import {
  findHistoricalMembershipDisplays,
  type FindHistoricalMembershipDisplaysInput,
  type HistoricalMembershipDisplay,
} from '../../domains/memberships/find-historical-membership-display.js';
import { SupplyActivitySourceIntegrityError } from '../../domains/supplies/errors.js';
import {
  findSupplyActivityDisplays,
  type FindSupplyActivityDisplaysInput,
  type SupplyActivityDisplay,
} from '../../domains/supplies/find-supply-activity-display.js';
import { TaskActivitySourceIntegrityError } from '../../domains/tasks/errors.js';
import {
  findTaskActivityDisplays,
  type FindTaskActivityDisplaysInput,
  type TaskActivityDisplay,
} from '../../domains/tasks/find-task-activity-display.js';
import { InvalidRequestError } from '../../platform/authz/errors.js';
import { NotificationProjectionIntegrityError } from './errors.js';

export type ListCurrentUserNotificationsInput = Readonly<{
  userId: string;
  limit?: number;
  cursor?: string;
}>;

export type ListCurrentUserNotificationsRepository = Pick<
  NotificationRepository,
  'listEligiblePageForUser'
>;

export type ListCurrentUserNotificationsDependencies = Readonly<{
  notifications: ListCurrentUserNotificationsRepository;
  findHistoricalMembershipDisplays: (
    input: FindHistoricalMembershipDisplaysInput,
  ) => Promise<ReadonlyMap<string, HistoricalMembershipDisplay>>;
  findTaskActivityDisplays: (
    input: FindTaskActivityDisplaysInput,
  ) => Promise<ReadonlyMap<string, TaskActivityDisplay>>;
  findSupplyActivityDisplays: (
    input: FindSupplyActivityDisplaysInput,
  ) => Promise<ReadonlyMap<string, SupplyActivityDisplay>>;
}>;

type DisplayQueryable = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: T[] }>;
};

function actorDisplay(
  membershipId: string | null,
  displays: ReadonlyMap<string, HistoricalMembershipDisplay>,
): NotificationListItem['actor'] {
  if (membershipId === null) {
    return null;
  }
  const name = displays.get(membershipId)?.name;
  if (name === undefined || name === null) {
    return null;
  }
  return Object.freeze({ name });
}

function sourcePresentation(
  notification: EligibleNotification,
  tasks: ReadonlyMap<string, TaskActivityDisplay>,
  supplies: ReadonlyMap<string, SupplyActivityDisplay>,
): NotificationSourcePresentation {
  if (notification.kind === 'ASSIGNED_TASK_COMPLETED') {
    const title = tasks.get(notification.sourceEntityId)?.title;
    return title === undefined ? null : Object.freeze({ type: 'TASK', title });
  }
  if (notification.kind === 'CREATED_SUPPLY_OBTAINED') {
    const title = supplies.get(notification.sourceEntityId)?.title;
    return title === undefined
      ? null
      : Object.freeze({ type: 'SUPPLY', title });
  }
  return null;
}

function destinationFor(
  notification: EligibleNotification,
): NotificationDestination {
  if (notification.kind === 'ASSIGNED_TASK_COMPLETED') {
    return Object.freeze({
      type: 'TASK',
      homeId: notification.homeId,
      taskInstanceId: notification.sourceEntityId,
    });
  }
  if (notification.kind === 'CREATED_SUPPLY_OBTAINED') {
    return Object.freeze({
      type: 'SUPPLY',
      homeId: notification.homeId,
      supplyEntryId: notification.sourceEntityId,
    });
  }
  if (notification.kind === 'MEMBERSHIP_ROLE_CHANGED') {
    return Object.freeze({
      type: 'ROOMMATES',
      homeId: notification.homeId,
    });
  }
  return Object.freeze({
    type: 'HOME',
    homeId: notification.homeId,
  });
}

function collectIdsByHome(items: readonly EligibleNotification[]): {
  byHome: Map<
    string,
    { membershipIds: string[]; taskIds: string[]; supplyIds: string[] }
  >;
} {
  const byHome = new Map<
    string,
    { membershipIds: Set<string>; taskIds: Set<string>; supplyIds: Set<string> }
  >();
  for (const item of items) {
    let bucket = byHome.get(item.homeId);
    if (bucket === undefined) {
      bucket = {
        membershipIds: new Set(),
        taskIds: new Set(),
        supplyIds: new Set(),
      };
      byHome.set(item.homeId, bucket);
    }
    if (item.actorMembershipId !== null) {
      bucket.membershipIds.add(item.actorMembershipId);
    }
    if (item.kind === 'ASSIGNED_TASK_COMPLETED') {
      bucket.taskIds.add(item.sourceEntityId);
    }
    if (item.kind === 'CREATED_SUPPLY_OBTAINED') {
      bucket.supplyIds.add(item.sourceEntityId);
    }
  }
  return {
    byHome: new Map(
      [...byHome.entries()].map(([homeId, bucket]) => [
        homeId,
        {
          membershipIds: [...bucket.membershipIds],
          taskIds: [...bucket.taskIds],
          supplyIds: [...bucket.supplyIds],
        },
      ]),
    ),
  };
}

async function loadDisplays(
  items: readonly EligibleNotification[],
  deps: ListCurrentUserNotificationsDependencies,
): Promise<{
  memberships: Map<string, HistoricalMembershipDisplay>;
  tasks: Map<string, TaskActivityDisplay>;
  supplies: Map<string, SupplyActivityDisplay>;
}> {
  const { byHome } = collectIdsByHome(items);
  const memberships = new Map<string, HistoricalMembershipDisplay>();
  const tasks = new Map<string, TaskActivityDisplay>();
  const supplies = new Map<string, SupplyActivityDisplay>();
  await Promise.all(
    [...byHome.entries()].map(async ([homeId, ids]) => {
      const [homeMemberships, homeTasks, homeSupplies] = await Promise.all([
        deps.findHistoricalMembershipDisplays({
          homeId,
          membershipIds: ids.membershipIds,
        }),
        deps.findTaskActivityDisplays({
          homeId,
          taskInstanceIds: ids.taskIds,
        }),
        deps.findSupplyActivityDisplays({
          homeId,
          supplyEntryIds: ids.supplyIds,
        }),
      ]);
      for (const [id, display] of homeMemberships) {
        memberships.set(id, display);
      }
      for (const [id, display] of homeTasks) {
        tasks.set(id, display);
      }
      for (const [id, display] of homeSupplies) {
        supplies.set(id, display);
      }
    }),
  );
  return { memberships, tasks, supplies };
}

function projectItems(
  items: readonly EligibleNotification[],
  memberships: ReadonlyMap<string, HistoricalMembershipDisplay>,
  tasks: ReadonlyMap<string, TaskActivityDisplay>,
  supplies: ReadonlyMap<string, SupplyActivityDisplay>,
): readonly NotificationListItem[] {
  return Object.freeze(
    items.map((item) =>
      Object.freeze({
        id: item.id,
        kind: item.kind,
        occurredAt: item.occurredAt,
        readAt: item.readAt,
        home: Object.freeze({
          id: item.homeId,
          name: item.homeName,
        }),
        actor: actorDisplay(item.actorMembershipId, memberships),
        source: sourcePresentation(item, tasks, supplies),
        destination: destinationFor(item),
      }),
    ),
  );
}

/**
 * Authorized current-user Notification list. Uses repository eligibility,
 * then owning-module public display ports. Does not filter, sort, or decode
 * cursors in application code.
 */
export async function listCurrentUserNotifications(
  input: ListCurrentUserNotificationsInput,
  deps: ListCurrentUserNotificationsDependencies,
): Promise<NotificationListPage> {
  const decision = decideNotificationList();
  if (!decision.allowed) {
    throw new InvalidRequestError();
  }

  let page: NotificationRepositoryPage;
  try {
    page = await deps.notifications.listEligiblePageForUser({
      userId: input.userId,
      limit: input.limit ?? NOTIFICATION_LIST_DEFAULT_LIMIT,
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    });
  } catch (error) {
    if (error instanceof InvalidNotificationRequestError) {
      throw new InvalidRequestError();
    }
    throw error;
  }

  try {
    const displays = await loadDisplays(page.items, deps);
    return Object.freeze({
      items: projectItems(
        page.items,
        displays.memberships,
        displays.tasks,
        displays.supplies,
      ),
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    });
  } catch (error) {
    if (
      error instanceof MembershipActivitySourceIntegrityError ||
      error instanceof TaskActivitySourceIntegrityError ||
      error instanceof SupplyActivitySourceIntegrityError
    ) {
      throw new NotificationProjectionIntegrityError();
    }
    throw error;
  }
}

export function createListCurrentUserNotificationsFromPool(
  pool: Parameters<typeof createNotificationRepository>[0],
): (input: ListCurrentUserNotificationsInput) => Promise<NotificationListPage> {
  const notifications = createNotificationRepository(pool);
  const db: DisplayQueryable = pool;
  return (input) =>
    listCurrentUserNotifications(input, {
      notifications,
      findHistoricalMembershipDisplays: (displayInput) =>
        findHistoricalMembershipDisplays(db, displayInput),
      findTaskActivityDisplays: (displayInput) =>
        findTaskActivityDisplays(db, displayInput),
      findSupplyActivityDisplays: (displayInput) =>
        findSupplyActivityDisplays(db, displayInput),
    });
}
