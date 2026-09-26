import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { HomeContext } from './home-context-api.js';
import {
  patchHomePhotoCachesAfterDelete,
  patchHomePhotoCachesAfterUpload,
  reconcileHomePhotoCachesAfterDelete,
  reconcileHomePhotoCachesAfterUpload,
} from './home-photo-cache.js';
import {
  currentUserHomesQueryKey,
  homeContextQueryKey,
  homePhotoQueryKey,
} from './home-query-keys.js';
import type { ActiveHome } from './homes-api.js';

const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const uploadedHome: HomeContext = {
  id: HOME_ID,
  name: 'Oak Street',
  timezone: 'UTC',
  hasPhoto: true,
};

const existingHomeRow: ActiveHome = {
  id: HOME_ID,
  name: 'Oak Street',
  timezone: 'UTC',
  hasPhoto: false,
  role: 'ROOMMATE',
};

const otherHomeRow: ActiveHome = {
  id: OTHER_HOME_ID,
  name: 'Pine Avenue',
  timezone: 'America/Chicago',
  hasPhoto: true,
  role: 'ADMIN',
};

describe('home photo cache helpers', () => {
  it('patchHomePhotoCachesAfterUpload updates context and homes list immediately', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(currentUserHomesQueryKey, [existingHomeRow]);

    patchHomePhotoCachesAfterUpload(queryClient, uploadedHome);

    expect(queryClient.getQueryData(homeContextQueryKey(HOME_ID))).toEqual(
      uploadedHome,
    );
    expect(queryClient.getQueryData(currentUserHomesQueryKey)).toEqual([
      { ...existingHomeRow, hasPhoto: true },
    ]);
  });

  it('patchHomePhotoCachesAfterUpload leaves unrelated Homes untouched', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(currentUserHomesQueryKey, [
      existingHomeRow,
      otherHomeRow,
    ]);

    patchHomePhotoCachesAfterUpload(queryClient, uploadedHome);

    expect(
      queryClient
        .getQueryData<ActiveHome[]>(currentUserHomesQueryKey)
        ?.find((home) => home.id === OTHER_HOME_ID),
    ).toEqual(otherHomeRow);
  });

  it('reconcileHomePhotoCachesAfterUpload invalidates homes and resets photo query', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const resetSpy = vi.spyOn(queryClient, 'resetQueries');
    queryClient.setQueryData(homePhotoQueryKey(HOME_ID), new Blob(['old']));

    reconcileHomePhotoCachesAfterUpload(queryClient, uploadedHome);

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: currentUserHomesQueryKey,
    });
    expect(resetSpy).toHaveBeenCalledWith({
      queryKey: homePhotoQueryKey(HOME_ID),
    });
  });

  it('patchHomePhotoCachesAfterDelete clears hasPhoto and photo blob immediately', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(homeContextQueryKey(HOME_ID), uploadedHome);
    queryClient.setQueryData(currentUserHomesQueryKey, [
      { ...existingHomeRow, hasPhoto: true },
    ]);
    queryClient.setQueryData(homePhotoQueryKey(HOME_ID), new Blob(['old']));

    patchHomePhotoCachesAfterDelete(queryClient, HOME_ID);

    expect(
      queryClient.getQueryData<HomeContext>(homeContextQueryKey(HOME_ID)),
    ).toMatchObject({ hasPhoto: false });
    expect(queryClient.getQueryData(currentUserHomesQueryKey)).toEqual([
      { ...existingHomeRow, hasPhoto: false },
    ]);
    expect(queryClient.getQueryData(homePhotoQueryKey(HOME_ID))).toBeUndefined();
  });

  it('reconcileHomePhotoCachesAfterDelete invalidates homes in the background', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    reconcileHomePhotoCachesAfterDelete(queryClient);

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: currentUserHomesQueryKey,
    });
  });
});
