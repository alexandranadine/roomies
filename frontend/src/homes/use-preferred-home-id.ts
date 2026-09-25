import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useLocation } from 'react-router';
import { currentUserHomesQueryKey } from './home-query-keys.js';
import { listCurrentUserHomes } from './homes-api.js';
import {
  collectCachedHomeContexts,
  parseHomeIdFromPath,
  readCurrentUserHomesFromCache,
  resolvePreferredHomeId,
} from './wordmark-home-href.js';

type UsePreferredHomeIdOptions = {
  enabled?: boolean;
};

/**
 * Current/preferred Home id for authenticated global routes, using the same
 * resolution rules as the Roomies wordmark.
 */
export function usePreferredHomeId(
  options: UsePreferredHomeIdOptions = {},
): string | undefined {
  const enabled = options.enabled ?? true;
  const { pathname } = useLocation();
  const queryClient = useQueryClient();
  const pathnameHomeId = parseHomeIdFromPath(pathname);
  const homesQuery = useQuery({
    queryKey: currentUserHomesQueryKey,
    queryFn: ({ signal }) => listCurrentUserHomes(signal),
    enabled: enabled && pathnameHomeId === undefined,
  });

  return useMemo(() => {
    return resolvePreferredHomeId({
      pathname,
      currentUserHomes: homesQuery.data ?? readCurrentUserHomesFromCache(queryClient),
      cachedHomeContexts: collectCachedHomeContexts(queryClient),
    });
  }, [homesQuery.data, pathname, queryClient]);
}
