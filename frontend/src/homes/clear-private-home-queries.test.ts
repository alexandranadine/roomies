import { describe, expect, it } from 'vitest';
import { createAppQueryClient } from '../platform/query/query-client.js';
import { clearPrivateHomeQueryState } from './clear-private-home-queries.js';
import {
  currentUserHomesQueryKey,
  currentUserQueryKey,
  homeContextQueryKey,
} from './home-query-keys.js';

const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('clearPrivateHomeQueryState', () => {
  it('removes Home discovery and Home-scoped cache without requiring persistence', () => {
    const queryClient = createAppQueryClient();
    queryClient.setQueryData(currentUserQueryKey, { id: HOME_ID });
    queryClient.setQueryData(currentUserHomesQueryKey, [
      { id: HOME_ID, name: 'Oak Street', timezone: 'UTC', role: 'ADMIN' },
    ]);
    queryClient.setQueryData(homeContextQueryKey(HOME_ID), {
      id: HOME_ID,
      name: 'Oak Street',
      timezone: 'UTC',
    });

    clearPrivateHomeQueryState(queryClient);

    expect(queryClient.getQueryData(currentUserHomesQueryKey)).toBeUndefined();
    expect(
      queryClient.getQueryData(homeContextQueryKey(HOME_ID)),
    ).toBeUndefined();
    expect(queryClient.getQueryData(currentUserQueryKey)).toEqual({
      id: HOME_ID,
    });
  });
});
