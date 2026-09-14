import { z } from 'zod';
import { NOTIFICATION_KINDS } from './notification.js';
import type {
  NotificationListItem,
  NotificationListPage,
} from './notification-list-item.js';

export const notificationHomeDisplayDtoSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

export const notificationActorDisplayDtoSchema = z
  .object({
    name: z.string().min(1),
  })
  .strict();

export const notificationSourceDtoSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('TASK'),
      title: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('SUPPLY'),
      title: z.string().min(1),
    })
    .strict(),
]);

export const notificationDestinationDtoSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('TASK'),
      homeId: z.string().min(1),
      taskInstanceId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('SUPPLY'),
      homeId: z.string().min(1),
      supplyEntryId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('ROOMMATES'),
      homeId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('HOME'),
      homeId: z.string().min(1),
    })
    .strict(),
]);

export const notificationListItemDtoSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(NOTIFICATION_KINDS),
    occurredAt: z.string().min(1),
    readAt: z.string().min(1).nullable(),
    home: notificationHomeDisplayDtoSchema,
    actor: notificationActorDisplayDtoSchema.nullable(),
    source: notificationSourceDtoSchema.nullable(),
    destination: notificationDestinationDtoSchema,
  })
  .strict();

export type NotificationListItemDto = z.infer<
  typeof notificationListItemDtoSchema
>;

export const notificationListPageDtoSchema = z
  .object({
    items: z.array(notificationListItemDtoSchema),
    hasMore: z.boolean(),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();

export type NotificationListPageDto = z.infer<
  typeof notificationListPageDtoSchema
>;

export function toNotificationListItemDto(
  item: NotificationListItem,
): NotificationListItemDto {
  return notificationListItemDtoSchema.parse({
    id: item.id,
    kind: item.kind,
    occurredAt: item.occurredAt.toISOString(),
    readAt: item.readAt === null ? null : item.readAt.toISOString(),
    home: item.home,
    actor: item.actor,
    source: item.source,
    destination: item.destination,
  });
}

export function toNotificationListPageDto(
  page: NotificationListPage,
): NotificationListPageDto {
  return notificationListPageDtoSchema.parse({
    items: page.items.map(toNotificationListItemDto),
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
  });
}
