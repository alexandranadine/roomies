import { useQuery } from '@tanstack/react-query';
import { shouldRetryQuery } from '../platform/query/query-client.js';
import { listHomeTaskDefinitions } from './tasks-api.js';
import { taskKeys } from './tasks-query-keys.js';

export type UseHomeTaskDefinitionsOptions = {
  homeId: string;
  enabled?: boolean;
};

/** Home-scoped TaskDefinition list, including deactivated rows. */
export function useHomeTaskDefinitions(options: UseHomeTaskDefinitionsOptions) {
  const { homeId, enabled = true } = options;

  return useQuery({
    queryKey: taskKeys.definitions(homeId),
    queryFn: ({ signal }) => listHomeTaskDefinitions(homeId, signal),
    enabled: enabled && homeId.length > 0,
    retry: shouldRetryQuery,
  });
}
