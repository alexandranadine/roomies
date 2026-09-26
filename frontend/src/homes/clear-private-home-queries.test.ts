import { describe, expect, it } from 'vitest';
import { notificationKeys } from '../notifications/notifications-query-keys.js';
import { createAppQueryClient } from '../platform/query/query-client.js';
import { pulseKeys } from '../pulse/pulse-query-keys.js';
import { clearHousePulse } from '../pulse/test-fixtures.js';
import { taskKeys } from '../tasks/tasks-query-keys.js';
import {
  clearPrivateHomeQueryState,
  handlePassiveAuthLoss,
} from './clear-private-home-queries.js';
import {
  currentUserHomesQueryKey,
  currentUserQueryKey,
  homeContextQueryKey,
  homePhotoQueryKey,
} from './home-query-keys.js';

const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('clearPrivateHomeQueryState', () => {
  it('removes Home discovery, Home-scoped cache including Pulse and Tasks, and Notifications without requiring persistence', () => {
    const queryClient = createAppQueryClient();
    queryClient.setQueryData(currentUserQueryKey, { id: HOME_ID });
    queryClient.setQueryData(currentUserHomesQueryKey, [
      {
        id: HOME_ID,
        name: 'Oak Street',
        timezone: 'UTC',
        role: 'ADMIN',
        hasPhoto: false,
      },
    ]);
    queryClient.setQueryData(homeContextQueryKey(HOME_ID), {
      id: HOME_ID,
      name: 'Oak Street',
      timezone: 'UTC',
      hasPhoto: false,
    });
    queryClient.setQueryData(homePhotoQueryKey(HOME_ID), new Blob(['photo']));
    queryClient.setQueryData(pulseKeys.all(HOME_ID), clearHousePulse());
    queryClient.setQueryData(taskKeys.list(HOME_ID), []);
    queryClient.setQueryData(taskKeys.definitions(HOME_ID), []);
    queryClient.setQueryData(notificationKeys.list({}), {
      pages: [{ items: [], hasMore: false, nextCursor: null }],
      pageParams: [undefined],
    });

    clearPrivateHomeQueryState(queryClient);

    expect(queryClient.getQueryData(currentUserHomesQueryKey)).toBeUndefined();
    expect(
      queryClient.getQueryData(homeContextQueryKey(HOME_ID)),
    ).toBeUndefined();
    expect(
      queryClient.getQueryData(homePhotoQueryKey(HOME_ID)),
    ).toBeUndefined();
    expect(queryClient.getQueryData(pulseKeys.all(HOME_ID))).toBeUndefined();
    expect(queryClient.getQueryData(taskKeys.list(HOME_ID))).toBeUndefined();
    expect(
      queryClient.getQueryData(taskKeys.definitions(HOME_ID)),
    ).toBeUndefined();
    expect(queryClient.getQueryData(notificationKeys.list({}))).toBeUndefined();
    expect(queryClient.getQueryData(currentUserQueryKey)).toEqual({
      id: HOME_ID,
    });
  });
});

describe('handlePassiveAuthLoss', () => {
  it('clears private Home state and removes current-user identity immediately', () => {
    const queryClient = createAppQueryClient();
    queryClient.setQueryData(currentUserQueryKey, { id: HOME_ID });
    queryClient.setQueryData(currentUserHomesQueryKey, [
      {
        id: HOME_ID,
        name: 'Oak Street',
        timezone: 'UTC',
        role: 'ADMIN',
        hasPhoto: false,
      },
    ]);
    queryClient.setQueryData(homeContextQueryKey(HOME_ID), {
      id: HOME_ID,
      name: 'Oak Street',
      timezone: 'UTC',
      hasPhoto: false,
    });
    queryClient.setQueryData(notificationKeys.list({}), {
      pages: [{ items: [], hasMore: false, nextCursor: null }],
      pageParams: [undefined],
    });

    handlePassiveAuthLoss(queryClient);

    expect(queryClient.getQueryData(currentUserQueryKey)).toBeUndefined();
    expect(queryClient.getQueryData(currentUserHomesQueryKey)).toBeUndefined();
    expect(
      queryClient.getQueryData(homeContextQueryKey(HOME_ID)),
    ).toBeUndefined();
    expect(queryClient.getQueryData(notificationKeys.list({}))).toBeUndefined();
  });
});
