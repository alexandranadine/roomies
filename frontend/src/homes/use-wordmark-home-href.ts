import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useLocation } from 'react-router';
import { currentUserHomesQueryKey } from './home-query-keys.js';
import { listCurrentUserHomes } from './homes-api.js';
import {
  collectCachedHomeContexts,
  parseHomeIdFromPath,
  readCurrentUserHomesFromCache,
  resolveWordmarkHomeHref,
} from './wordmark-home-href.js';

type UseWordmarkHomeHrefOptions = {
  enabled?: boolean;
};

/**
 * Wordmark destination for authenticated global chrome on non-Home routes.
 */
export function useWordmarkHomeHref(
  options: UseWordmarkHomeHrefOptions = {},
): string {
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
    return resolveWordmarkHomeHref({
      pathname,
      currentUserHomes: homesQuery.data ?? readCurrentUserHomesFromCache(queryClient),
      cachedHomeContexts: collectCachedHomeContexts(queryClient),
    });
  }, [homesQuery.data, pathname, queryClient]);
}
