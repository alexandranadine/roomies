import { useInfiniteQuery } from '@tanstack/react-query';
import { shouldRetryQuery } from '../platform/query/query-client.js';
import { listHomeActivity } from './activity-api.js';
import { activityKeys } from './activity-query-keys.js';

export type UseActivityListOptions = {
  homeId: string;
  enabled?: boolean;
};

/**
 * Cursor-paginated Activity list for one Home.
 * Preserve backend order; do not client-sort or send a page-size override.
 */
export function useActivityList(options: UseActivityListOptions) {
  const { homeId, enabled = true } = options;

  return useInfiniteQuery({
    queryKey: activityKeys.list(homeId),
    queryFn: ({ pageParam, signal }) =>
      listHomeActivity(homeId, {
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
    enabled: enabled && homeId.length > 0,
    retry: shouldRetryQuery,
  });
}
