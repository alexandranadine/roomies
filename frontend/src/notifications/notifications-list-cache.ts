import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import type { NotificationListPage } from './notifications-api.js';
import { notificationKeys } from './notifications-query-keys.js';

export type NotificationListInfiniteData = InfiniteData<
  NotificationListPage,
  string | undefined
>;

/**
 * Mark-one and read-all return 204 with no body. UI only checks `readAt === null`
 * (never displayed). Background invalidation reconciles authoritative timestamps.
 */
export const READ_IN_CACHE_PLACEHOLDER = '1970-01-01T00:00:00.000Z' as const;

function updateAllListCaches(
  queryClient: QueryClient,
  updater: (data: NotificationListInfiniteData) => NotificationListInfiniteData,
): void {
  for (const [queryKey, data] of queryClient.getQueriesData<NotificationListInfiniteData>(
    { queryKey: notificationKeys.lists() },
  )) {
    if (data === undefined) {
      continue;
    }
    const next = updater(data);
    if (next !== data) {
      queryClient.setQueryData(queryKey, next);
    }
  }
}

/** Marks one cached notification read after a successful mark-one 204. */
export function markNotificationReadInCache(
  queryClient: QueryClient,
  notificationId: string,
): void {
  updateAllListCaches(queryClient, (data) => ({
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((item) =>
        item.id === notificationId && item.readAt === null
          ? { ...item, readAt: READ_IN_CACHE_PLACEHOLDER }
          : item,
      ),
    })),
  }));
}

/** Marks every cached notification read after a successful read-all 204. */
export function markAllNotificationsReadInCache(queryClient: QueryClient): void {
  updateAllListCaches(queryClient, (data) => ({
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((item) =>
        item.readAt === null
          ? { ...item, readAt: READ_IN_CACHE_PLACEHOLDER }
          : item,
      ),
    })),
  }));
}
