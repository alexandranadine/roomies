import { useInfiniteQuery } from '@tanstack/react-query';
import { shouldRetryQuery } from '../platform/query/query-client.js';
import { listNotifications } from './notifications-api.js';
import { notificationKeys } from './notifications-query-keys.js';

export type UseNotificationsListOptions = {
  enabled?: boolean;
};

/**
 * Cursor-paginated global Notification list for the current User.
 * Preserve backend order; do not client-sort or scope by active Home.
 */
export function useNotificationsList(
  options: UseNotificationsListOptions = {},
) {
  const { enabled = true } = options;

  return useInfiniteQuery({
    queryKey: notificationKeys.list({}),
    queryFn: ({ pageParam, signal }) =>
      listNotifications({
        ...(pageParam !== undefined ? { cursor: pageParam } : {}),
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => {
      if (!lastPage.hasMore || lastPage.nextCursor === null) {
        return undefined;
      }
      return lastPage.nextCursor;
    },
    enabled,
    retry: shouldRetryQuery,
  });
}
