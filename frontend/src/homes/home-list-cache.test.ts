import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { CreatedHome } from './create-home-api.js';
import { currentUserHomesQueryKey } from './home-query-keys.js';
import type { ActiveHome } from './homes-api.js';
import {
  seedCurrentUserHomesCacheAfterCreate,
  toActiveHomeFromCreated,
} from './home-list-cache.js';

const EXISTING_HOME_ID = '11111111-1111-4111-8111-111111111111';
const NEW_HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const createdHome: CreatedHome = {
  home: {
    id: NEW_HOME_ID,
    name: 'Oak Street',
    timezone: 'America/New_York',
    hasPhoto: false,
  },
  membership: {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    role: 'ADMIN',
  },
};

const existingHome: ActiveHome = {
  id: EXISTING_HOME_ID,
  name: 'Pine Avenue',
  timezone: 'America/Chicago',
  hasPhoto: true,
  role: 'ROOMMATE',
};

describe('home list cache helpers', () => {
  it('toActiveHomeFromCreated maps only authoritative create fields', () => {
    expect(toActiveHomeFromCreated(createdHome)).toEqual({
      id: NEW_HOME_ID,
      name: 'Oak Street',
      timezone: 'America/New_York',
      hasPhoto: false,
      role: 'ADMIN',
    });
  });

  it('appends the new Home once into an existing cache in name order', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(currentUserHomesQueryKey, [existingHome]);

    seedCurrentUserHomesCacheAfterCreate(queryClient, createdHome);

    expect(queryClient.getQueryData(currentUserHomesQueryKey)).toEqual([
      toActiveHomeFromCreated(createdHome),
      existingHome,
    ]);
  });

  it('seeds a zero-Homes cache with the created Home', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(currentUserHomesQueryKey, []);

    seedCurrentUserHomesCacheAfterCreate(queryClient, createdHome);

    expect(queryClient.getQueryData(currentUserHomesQueryKey)).toEqual([
      toActiveHomeFromCreated(createdHome),
    ]);
  });

  it('does not duplicate an existing Home row', () => {
    const queryClient = new QueryClient();
    const entry = toActiveHomeFromCreated(createdHome);
    queryClient.setQueryData(currentUserHomesQueryKey, [entry]);

    seedCurrentUserHomesCacheAfterCreate(queryClient, createdHome);

    expect(queryClient.getQueryData(currentUserHomesQueryKey)).toEqual([
      entry,
    ]);
  });

  it('leaves an undefined cache untouched', () => {
    const queryClient = new QueryClient();

    seedCurrentUserHomesCacheAfterCreate(queryClient, createdHome);

    expect(queryClient.getQueryData(currentUserHomesQueryKey)).toBeUndefined();
  });

  it('preserves unrelated Homes when adding a new one', () => {
    const queryClient = new QueryClient();
    const otherHome: ActiveHome = {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      name: 'Willow Lane',
      timezone: 'UTC',
      hasPhoto: false,
      role: 'ADMIN',
    };
    queryClient.setQueryData(currentUserHomesQueryKey, [existingHome, otherHome]);

    seedCurrentUserHomesCacheAfterCreate(queryClient, createdHome);

    const homes = queryClient.getQueryData<ActiveHome[]>(
      currentUserHomesQueryKey,
    );
    expect(homes?.map((home) => home.id).sort()).toEqual(
      [EXISTING_HOME_ID, NEW_HOME_ID, otherHome.id].sort(),
    );
    expect(homes?.find((home) => home.id === EXISTING_HOME_ID)).toEqual(
      existingHome,
    );
    expect(homes?.find((home) => home.id === otherHome.id)).toEqual(otherHome);
  });
});
