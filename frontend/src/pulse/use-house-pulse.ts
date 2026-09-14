import { useQuery } from '@tanstack/react-query';
import { shouldRetryQuery } from '../platform/query/query-client.js';
import { getHousePulse } from './pulse-api.js';
import { pulseKeys } from './pulse-query-keys.js';

export type UseHousePulseOptions = {
  homeId: string;
  enabled?: boolean;
};

/**
 * Current House Pulse snapshot for one Home.
 * No polling, no persistence, no placeholderData across Homes.
 */
export function useHousePulse(options: UseHousePulseOptions) {
  const { homeId, enabled = true } = options;

  return useQuery({
    queryKey: pulseKeys.all(homeId),
    queryFn: ({ signal }) => getHousePulse(homeId, signal),
    enabled: enabled && homeId.length > 0,
    retry: shouldRetryQuery,
    refetchInterval: false,
  });
}
