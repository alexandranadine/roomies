import { useInfiniteQuery } from '@tanstack/react-query';
import { shouldRetryQuery } from '../platform/query/query-client.js';
import {
  listHomeMaintenance,
  type MaintenanceStatus,
} from './maintenance-api.js';
import { maintenanceKeys } from './maintenance-query-keys.js';

export type UseMaintenanceListOptions = {
  homeId: string;
  status?: MaintenanceStatus;
  enabled?: boolean;
};

/**
 * Cursor-paginated Maintenance list for one Home.
 * Preserve backend order; do not client-sort.
 */
export function useMaintenanceList(options: UseMaintenanceListOptions) {
  const { homeId, status, enabled = true } = options;
  const filters = status === undefined ? {} : { status };

  return useInfiniteQuery({
    queryKey: maintenanceKeys.list(homeId, filters),
    queryFn: ({ pageParam, signal }) =>
      listHomeMaintenance(homeId, {
        ...(status !== undefined ? { status } : {}),
        ...(pageParam !== undefined ? { cursor: pageParam } : {}),
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => {
      if (!lastPage.hasMore) {
        return undefined;
      }
      return lastPage.nextCursor ?? undefined;
    },
    enabled: enabled && homeId.length > 0,
    retry: shouldRetryQuery,
  });
}
