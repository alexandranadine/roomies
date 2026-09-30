import { z } from 'zod';
import { MEMBERSHIP_STARTED_KINDS } from '../memberships/find-membership-started-kinds-for-activity.js';
import type {
  ActivityListItem,
  ActivityListPage,
} from './activity-list-item.js';

export const activityActorDisplayDtoSchema = z
  .object({
    membershipId: z.string().min(1),
    name: z.string().min(1).nullable(),
  })
  .strict();

export type ActivityActorDisplayDto = z.infer<
  typeof activityActorDisplayDtoSchema
>;

export const activityListItemDtoSchema = z
  .object({
    id: z.string().min(1),
    eventType: z.string().min(1),
    sourceEntityType: z.enum(['MEMBERSHIP', 'TASK', 'SUPPLY', 'MAINTENANCE']),
    sourceEntityId: z.string().min(1),
    occurredAt: z.string().min(1),
    actor: activityActorDisplayDtoSchema.nullable(),
    sourceTitle: z.string().min(1).nullable(),
    subject: activityActorDisplayDtoSchema.nullable(),
    membershipStartedKind: z.enum(MEMBERSHIP_STARTED_KINDS).nullable(),
  })
  .strict();

export type ActivityListItemDto = z.infer<typeof activityListItemDtoSchema>;

export const activityListPageDtoSchema = z
  .object({
    items: z.array(activityListItemDtoSchema),
    hasMore: z.boolean(),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();

export type ActivityListPageDto = z.infer<typeof activityListPageDtoSchema>;

export function toActivityListItemDto(
  item: ActivityListItem,
): ActivityListItemDto {
  return activityListItemDtoSchema.parse({
    id: item.id,
    eventType: item.eventType,
    sourceEntityType: item.sourceEntityType,
    sourceEntityId: item.sourceEntityId,
    occurredAt: item.occurredAt.toISOString(),
    actor: item.actor,
    sourceTitle: item.sourceTitle,
    subject: item.subject,
    membershipStartedKind: item.membershipStartedKind,
  });
}

export function toActivityListPageDto(
  page: ActivityListPage,
): ActivityListPageDto {
  return activityListPageDtoSchema.parse({
    items: page.items.map(toActivityListItemDto),
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
  });
}
