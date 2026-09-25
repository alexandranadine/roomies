import type { QueryClient } from '@tanstack/react-query';
import type { HomeContext } from './home-context-api.js';
import { currentUserHomesQueryKey } from './home-query-keys.js';
import type { ActiveHome } from './homes-api.js';

const HOME_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function homeOverviewHref(homeId: string): string {
  return `/homes/${encodeURIComponent(homeId)}`;
}

export function parseHomeIdFromPath(pathname: string): string | undefined {
  const match = /^\/homes\/([^/]+)/.exec(pathname);
  if (match === null) {
    return undefined;
  }
  const homeId = decodeURIComponent(match[1] ?? '');
  return HOME_ID_PATTERN.test(homeId) ? homeId : undefined;
}

export type CachedHomeContext = {
  homeId: string;
  dataUpdatedAt: number;
};

export type WordmarkHomeResolutionInput = {
  pathname: string;
  currentUserHomes: readonly Pick<ActiveHome, 'id'>[] | undefined;
  cachedHomeContexts: readonly CachedHomeContext[];
};

/**
 * Resolve the authenticated Roomies wordmark destination from existing
 * session and query state. Never guesses a Home when resolution is ambiguous.
 */
export function resolveWordmarkHomeHref(
  input: WordmarkHomeResolutionInput,
): string {
  const pathnameHomeId = parseHomeIdFromPath(input.pathname);
  if (pathnameHomeId !== undefined) {
    return homeOverviewHref(pathnameHomeId);
  }

  const homes = input.currentUserHomes;
  if (homes !== undefined && homes.length === 1) {
    const onlyHome = homes[0];
    if (onlyHome !== undefined) {
      return homeOverviewHref(onlyHome.id);
    }
  }

  const authorizedHomeIds =
    homes === undefined ? undefined : new Set(homes.map((home) => home.id));

  const recentContext = [...input.cachedHomeContexts]
    .filter(({ homeId }) => {
      if (!HOME_ID_PATTERN.test(homeId)) {
        return false;
      }
      if (authorizedHomeIds === undefined) {
        return true;
      }
      return authorizedHomeIds.has(homeId);
    })
    .sort((left, right) => right.dataUpdatedAt - left.dataUpdatedAt)[0];

  if (recentContext !== undefined) {
    return homeOverviewHref(recentContext.homeId);
  }

  return '/';
}

/**
 * Resolve a Home id for cross-Home authenticated routes. Returns undefined
 * when the same inputs would fall back to discovery (`/`).
 */
export function resolvePreferredHomeId(
  input: WordmarkHomeResolutionInput,
): string | undefined {
  const href = resolveWordmarkHomeHref(input);
  if (href === '/') {
    return undefined;
  }
  return parseHomeIdFromPath(href);
}

export function collectCachedHomeContexts(
  queryClient: QueryClient,
): readonly CachedHomeContext[] {
  return queryClient
    .getQueryCache()
    .getAll()
    .flatMap((query) => {
      const key = query.queryKey;
      if (key.length !== 3 || key[0] !== 'home' || key[2] !== 'context') {
        return [];
      }
      const homeId = key[1];
      if (typeof homeId !== 'string' || query.state.data === undefined) {
        return [];
      }
      const context = query.state.data as HomeContext;
      if (context.id !== homeId) {
        return [];
      }
      return [{ homeId, dataUpdatedAt: query.state.dataUpdatedAt }];
    });
}

export function readCurrentUserHomesFromCache(
  queryClient: QueryClient,
): readonly ActiveHome[] | undefined {
  return queryClient.getQueryData<readonly ActiveHome[]>(
    currentUserHomesQueryKey,
  );
}
