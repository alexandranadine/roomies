import type { Activity } from '../../domains/activity/activity.js';
import type {
  ActivityActorDisplay,
  ActivityListItem,
  ActivityListPage,
  ActivityRepositoryPage,
} from '../../domains/activity/activity-list-item.js';
import { ACTIVITY_LIST_DEFAULT_LIMIT } from '../../domains/activity/cursor.js';
import { InvalidActivityRequestError } from '../../domains/activity/errors.js';
import { decideActivityList } from '../../domains/activity/list-policy.js';
import {
  createActivityRepository,
  type ActivityRepository,
} from '../../domains/activity/repository.js';
import { MaintenanceActivitySourceIntegrityError } from '../../domains/maintenance/errors.js';
import {
  findMaintenanceActivityDisplays,
  type FindMaintenanceActivityDisplaysInput,
  type MaintenanceActivityDisplay,
} from '../../domains/maintenance/find-maintenance-activity-display.js';
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
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  InvalidRequestError,
} from '../../platform/authz/errors.js';
import { ActivityProjectionIntegrityError } from './errors.js';

export type ListHomeActivityInput = Readonly<{
  actor: ActiveHomeActor;
  homeId: string;
  limit?: number;
  cursor?: string;
}>;

export type ListHomeActivityRepository = Pick<
  ActivityRepository,
  'listVisiblePageByHome'
>;

export type ListHomeActivityDependencies = Readonly<{
  activity: ListHomeActivityRepository;
  findHistoricalMembershipDisplays: (
    input: FindHistoricalMembershipDisplaysInput,
  ) => Promise<ReadonlyMap<string, HistoricalMembershipDisplay>>;
  findTaskActivityDisplays: (
    input: FindTaskActivityDisplaysInput,
  ) => Promise<ReadonlyMap<string, TaskActivityDisplay>>;
  findSupplyActivityDisplays: (
    input: FindSupplyActivityDisplaysInput,
  ) => Promise<ReadonlyMap<string, SupplyActivityDisplay>>;
  findMaintenanceActivityDisplays: (
    input: FindMaintenanceActivityDisplaysInput,
  ) => Promise<ReadonlyMap<string, MaintenanceActivityDisplay>>;
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
): ActivityActorDisplay | null {
  if (membershipId === null) {
    return null;
  }
  const found = displays.get(membershipId);
  return Object.freeze({
    membershipId,
    name: found?.name ?? null,
  });
}

function sourceTitleForActivity(
  activity: Activity,
  tasks: ReadonlyMap<string, TaskActivityDisplay>,
  supplies: ReadonlyMap<string, SupplyActivityDisplay>,
  maintenance: ReadonlyMap<string, MaintenanceActivityDisplay>,
): string | null {
  if (activity.sourceEntityType === 'TASK') {
    return tasks.get(activity.sourceEntityId)?.title ?? null;
  }
  if (activity.sourceEntityType === 'SUPPLY') {
    return supplies.get(activity.sourceEntityId)?.title ?? null;
  }
  if (activity.sourceEntityType === 'MAINTENANCE') {
    return maintenance.get(activity.sourceEntityId)?.title ?? null;
  }
  return null;
}

function projectItems(
  activities: readonly Activity[],
  memberships: ReadonlyMap<string, HistoricalMembershipDisplay>,
  tasks: ReadonlyMap<string, TaskActivityDisplay>,
  supplies: ReadonlyMap<string, SupplyActivityDisplay>,
  maintenance: ReadonlyMap<string, MaintenanceActivityDisplay>,
): readonly ActivityListItem[] {
  return Object.freeze(
    activities.map((activity) =>
      Object.freeze({
        id: activity.id,
        eventType: activity.eventType,
        sourceEntityType: activity.sourceEntityType,
        sourceEntityId: activity.sourceEntityId,
        occurredAt: activity.occurredAt,
        actor: actorDisplay(activity.actorMembershipId, memberships),
        sourceTitle: sourceTitleForActivity(
          activity,
          tasks,
          supplies,
          maintenance,
        ),
        subject:
          activity.sourceEntityType === 'MEMBERSHIP'
            ? actorDisplay(activity.sourceEntityId, memberships)
            : null,
      }),
    ),
  );
}

function collectIds(activities: readonly Activity[]): {
  membershipIds: string[];
  taskIds: string[];
  supplyIds: string[];
  maintenanceIds: string[];
} {
  const membershipIds = new Set<string>();
  const taskIds = new Set<string>();
  const supplyIds = new Set<string>();
  const maintenanceIds = new Set<string>();
  for (const activity of activities) {
    if (activity.actorMembershipId !== null) {
      membershipIds.add(activity.actorMembershipId);
    }
    if (activity.sourceEntityType === 'MEMBERSHIP') {
      membershipIds.add(activity.sourceEntityId);
    }
    if (activity.sourceEntityType === 'TASK') {
      taskIds.add(activity.sourceEntityId);
    }
    if (activity.sourceEntityType === 'SUPPLY') {
      supplyIds.add(activity.sourceEntityId);
    }
    if (activity.sourceEntityType === 'MAINTENANCE') {
      maintenanceIds.add(activity.sourceEntityId);
    }
  }
  return {
    membershipIds: [...membershipIds],
    taskIds: [...taskIds],
    supplyIds: [...supplyIds],
    maintenanceIds: [...maintenanceIds],
  };
}

/**
 * Authorized Home Activity list. Uses activity.list, then the repository
 * visible page, then public source-display ports. Does not filter, sort, or
 * decode cursors in application code.
 */
export async function listHomeActivity(
  input: ListHomeActivityInput,
  deps: ListHomeActivityDependencies,
): Promise<ActivityListPage> {
  const decision = decideActivityList({
    actor: input.actor,
    targetHomeId: input.homeId,
  });
  if (!decision.allowed) {
    throw new ConcealedNotFoundError();
  }

  let page: ActivityRepositoryPage | null;
  try {
    page = await deps.activity.listVisiblePageByHome({
      homeId: input.homeId,
      actorMembershipId: input.actor.membershipId,
      limit: input.limit ?? ACTIVITY_LIST_DEFAULT_LIMIT,
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    });
  } catch (error) {
    if (error instanceof InvalidActivityRequestError) {
      throw new InvalidRequestError();
    }
    throw error;
  }
  if (page === null) {
    throw new ConcealedNotFoundError();
  }

  const ids = collectIds(page.items);
  try {
    const [memberships, tasks, supplies, maintenance] = await Promise.all([
      deps.findHistoricalMembershipDisplays({
        homeId: input.homeId,
        membershipIds: ids.membershipIds,
      }),
      deps.findTaskActivityDisplays({
        homeId: input.homeId,
        taskInstanceIds: ids.taskIds,
      }),
      deps.findSupplyActivityDisplays({
        homeId: input.homeId,
        supplyEntryIds: ids.supplyIds,
      }),
      deps.findMaintenanceActivityDisplays({
        homeId: input.homeId,
        maintenanceEntryIds: ids.maintenanceIds,
      }),
    ]);
    return Object.freeze({
      items: projectItems(
        page.items,
        memberships,
        tasks,
        supplies,
        maintenance,
      ),
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    });
  } catch (error) {
    if (
      error instanceof MembershipActivitySourceIntegrityError ||
      error instanceof TaskActivitySourceIntegrityError ||
      error instanceof SupplyActivitySourceIntegrityError ||
      error instanceof MaintenanceActivitySourceIntegrityError
    ) {
      throw new ActivityProjectionIntegrityError();
    }
    throw error;
  }
}

export function createListHomeActivityFromPool(
  pool: Parameters<typeof createActivityRepository>[0],
): (input: ListHomeActivityInput) => Promise<ActivityListPage> {
  const activity = createActivityRepository(pool);
  const db: DisplayQueryable = pool;
  return (input) =>
    listHomeActivity(input, {
      activity,
      findHistoricalMembershipDisplays: (displayInput) =>
        findHistoricalMembershipDisplays(db, displayInput),
      findTaskActivityDisplays: (displayInput) =>
        findTaskActivityDisplays(db, displayInput),
      findSupplyActivityDisplays: (displayInput) =>
        findSupplyActivityDisplays(db, displayInput),
      findMaintenanceActivityDisplays: (displayInput) =>
        findMaintenanceActivityDisplays(db, displayInput),
    });
}
