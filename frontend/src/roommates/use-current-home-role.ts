import { useQuery } from '@tanstack/react-query';
import { listCurrentUserHomes } from '../homes/homes-api.js';
import { currentUserHomesQueryKey } from '../homes/home-query-keys.js';

/**
 * Current User's role in this Home from GET /me/homes.
 * Admin UI is convenience-only; backend remains authoritative.
 * Unknown/missing role never grants Admin controls.
 */
export function useCurrentHomeRole(homeId: string) {
  const homesQuery = useQuery({
    queryKey: currentUserHomesQueryKey,
    queryFn: ({ signal }) => listCurrentUserHomes(signal),
    enabled: homeId.length > 0,
  });

  const role = homesQuery.data?.find((home) => home.id === homeId)?.role;

  return {
    role,
    isAdmin: role === 'ADMIN',
    homesQuery,
  };
}
