import { useQuery } from '@tanstack/react-query';
import { shouldRetryQuery } from '../platform/query/query-client.js';
import { listHomeMemberships } from './home-memberships-api.js';
import { homeMembershipsKeys } from './home-memberships-query-keys.js';

export type UseHomeMembershipsOptions = {
  homeId: string;
  enabled?: boolean;
};

/** Active Memberships for one Home (PRIVATE audience picker source). */
export function useHomeMemberships(options: UseHomeMembershipsOptions) {
  const { homeId, enabled = true } = options;

  return useQuery({
    queryKey: homeMembershipsKeys.all(homeId),
    queryFn: ({ signal }) => listHomeMemberships(homeId, signal),
    enabled: enabled && homeId.length > 0,
    retry: shouldRetryQuery,
  });
}
