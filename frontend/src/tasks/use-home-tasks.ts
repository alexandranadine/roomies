import { useQuery } from '@tanstack/react-query';
import { shouldRetryQuery } from '../platform/query/query-client.js';
import { listHomeTasks } from './tasks-api.js';
import { taskKeys } from './tasks-query-keys.js';

export type UseHomeTasksOptions = {
  homeId: string;
  enabled?: boolean;
};

/** Home-scoped TaskInstance list. Preserve backend order. */
export function useHomeTasks(options: UseHomeTasksOptions) {
  const { homeId, enabled = true } = options;

  return useQuery({
    queryKey: taskKeys.list(homeId),
    queryFn: ({ signal }) => listHomeTasks(homeId, signal),
    enabled: enabled && homeId.length > 0,
    retry: shouldRetryQuery,
  });
}
