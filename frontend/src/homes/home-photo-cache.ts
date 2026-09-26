import type { QueryClient } from '@tanstack/react-query';
import type { HomeContext } from './home-context-api.js';
import {
  currentUserHomesQueryKey,
  homeContextQueryKey,
  homePhotoQueryKey,
} from './home-query-keys.js';
import type { ActiveHome } from './homes-api.js';

function patchHomesList(
  queryClient: QueryClient,
  homeId: string,
  patch: { hasPhoto: boolean; name?: string; timezone?: string },
): void {
  queryClient.setQueryData(
    currentUserHomesQueryKey,
    (homes: readonly ActiveHome[] | undefined) => {
      if (homes === undefined) {
        return homes;
      }
      return homes.map((row) =>
        row.id === homeId ? { ...row, ...patch } : row,
      );
    },
  );
}

/**
 * Synchronous authoritative cache patches after successful photo upload/finalize.
 */
export function patchHomePhotoCachesAfterUpload(
  queryClient: QueryClient,
  home: HomeContext,
): void {
  queryClient.setQueryData(homeContextQueryKey(home.id), home);
  patchHomesList(queryClient, home.id, {
    hasPhoto: home.hasPhoto,
    name: home.name,
    timezone: home.timezone,
  });
}

/**
 * Background reconciliation and photo-blob refresh after upload success.
 * resetQueries clears stale Blobs synchronously; refetch runs without blocking UI.
 */
export function reconcileHomePhotoCachesAfterUpload(
  queryClient: QueryClient,
  home: HomeContext,
): void {
  void queryClient.invalidateQueries({ queryKey: currentUserHomesQueryKey });
  if (home.hasPhoto) {
    void queryClient.resetQueries({ queryKey: homePhotoQueryKey(home.id) });
    return;
  }
  queryClient.setQueryData(homePhotoQueryKey(home.id), null);
  queryClient.removeQueries({ queryKey: homePhotoQueryKey(home.id) });
}

/**
 * Synchronous authoritative cache patches after successful photo delete.
 */
export function patchHomePhotoCachesAfterDelete(
  queryClient: QueryClient,
  homeId: string,
): void {
  queryClient.setQueryData(
    homeContextQueryKey(homeId),
    (current: HomeContext | undefined) =>
      current === undefined ? current : { ...current, hasPhoto: false },
  );
  patchHomesList(queryClient, homeId, { hasPhoto: false });
  queryClient.setQueryData(homePhotoQueryKey(homeId), null);
  queryClient.removeQueries({ queryKey: homePhotoQueryKey(homeId) });
}

/** Background /me/homes reconciliation after photo delete success. */
export function reconcileHomePhotoCachesAfterDelete(
  queryClient: QueryClient,
): void {
  void queryClient.invalidateQueries({ queryKey: currentUserHomesQueryKey });
}
