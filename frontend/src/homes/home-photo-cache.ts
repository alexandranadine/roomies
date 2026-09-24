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
 * After a successful photo mutate: update Home identity, refresh /me/homes,
 * and force the photo Blob query to change even when `hasPhoto` stays true.
 */
export async function syncHomePhotoCaches(
  queryClient: QueryClient,
  home: HomeContext,
): Promise<void> {
  queryClient.setQueryData(homeContextQueryKey(home.id), home);
  patchHomesList(queryClient, home.id, {
    hasPhoto: home.hasPhoto,
    name: home.name,
    timezone: home.timezone,
  });
  await queryClient.invalidateQueries({ queryKey: currentUserHomesQueryKey });
  if (home.hasPhoto) {
    await queryClient.resetQueries({ queryKey: homePhotoQueryKey(home.id) });
    return;
  }
  queryClient.setQueryData(homePhotoQueryKey(home.id), null);
  queryClient.removeQueries({ queryKey: homePhotoQueryKey(home.id) });
}

export async function clearHomePhotoAfterDelete(
  queryClient: QueryClient,
  homeId: string,
): Promise<void> {
  queryClient.setQueryData(
    homeContextQueryKey(homeId),
    (current: HomeContext | undefined) =>
      current === undefined ? current : { ...current, hasPhoto: false },
  );
  patchHomesList(queryClient, homeId, { hasPhoto: false });
  queryClient.setQueryData(homePhotoQueryKey(homeId), null);
  await queryClient.invalidateQueries({ queryKey: currentUserHomesQueryKey });
  queryClient.removeQueries({ queryKey: homePhotoQueryKey(homeId) });
}
