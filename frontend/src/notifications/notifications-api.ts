import { z } from 'zod';
import { getApiClient } from '../platform/api/index.js';

/**
 * Wire DTOs mirror the frozen M7.3 notification list contract.
 * `kind` is a plain string so unknown future kinds fail safely in presentation
 * instead of rejecting the whole page parse.
 */

export const notificationHomeDisplaySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

export type NotificationHomeDisplay = z.infer<
  typeof notificationHomeDisplaySchema
>;

export const notificationActorDisplaySchema = z
  .object({
    name: z.string().min(1),
  })
  .strict();

export type NotificationActorDisplay = z.infer<
  typeof notificationActorDisplaySchema
>;

export const notificationSourceSchema = z.discriminatedUnion('type', [
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

export type NotificationSource = z.infer<typeof notificationSourceSchema>;

export const notificationDestinationSchema = z.discriminatedUnion('type', [
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

export type NotificationDestination = z.infer<
  typeof notificationDestinationSchema
>;

export const notificationListItemSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    occurredAt: z.string().min(1),
    readAt: z.string().min(1).nullable(),
    home: notificationHomeDisplaySchema,
    actor: notificationActorDisplaySchema.nullable(),
    source: notificationSourceSchema.nullable(),
    destination: notificationDestinationSchema,
  })
  .strict();

export type NotificationListItem = z.infer<typeof notificationListItemSchema>;

export const notificationListPageSchema = z
  .object({
    items: z.array(notificationListItemSchema),
    hasMore: z.boolean(),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();

export type NotificationListPage = z.infer<typeof notificationListPageSchema>;

export type ListNotificationsParams = {
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
};

function buildListPath(
  params: Omit<ListNotificationsParams, 'signal'>,
): string {
  const search = new URLSearchParams();
  if (params.limit !== undefined) {
    search.set('limit', String(params.limit));
  }
  if (params.cursor !== undefined) {
    search.set('cursor', params.cursor);
  }
  const query = search.toString();
  const base = '/api/v1/notifications';
  return query.length > 0 ? `${base}?${query}` : base;
}

/** GET /api/v1/notifications — current-user global inbox (no homeId). */
export async function listNotifications(
  params: ListNotificationsParams = {},
): Promise<NotificationListPage> {
  const { signal, ...query } = params;
  const body = await getApiClient().request<unknown>({
    path: buildListPath(query),
    signal,
  });
  return notificationListPageSchema.parse(body);
}

/** POST /api/v1/notifications/:notificationId/read — 204. */
export async function markNotificationRead(
  notificationId: string,
  signal?: AbortSignal,
): Promise<void> {
  await getApiClient().request<unknown>({
    method: 'POST',
    path: `/api/v1/notifications/${encodeURIComponent(notificationId)}/read`,
    body: {},
    signal,
  });
}

/** POST /api/v1/notifications/read-all — 204. */
export async function readAllNotifications(
  signal?: AbortSignal,
): Promise<void> {
  await getApiClient().request<unknown>({
    method: 'POST',
    path: '/api/v1/notifications/read-all',
    body: {},
    signal,
  });
}
