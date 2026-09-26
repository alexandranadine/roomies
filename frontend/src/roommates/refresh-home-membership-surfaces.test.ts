import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { homeMembershipsKeys } from '../homes/home-memberships-query-keys.js';
import { currentUserHomesQueryKey } from '../homes/home-query-keys.js';
import type { ActiveHome } from '../homes/homes-api.js';
import {
  patchCurrentUserHomeRole,
  reconcileHomeMembershipSurfaces,
  removeMembershipFromHomeCache,
} from './refresh-home-membership-surfaces.js';
import {
  CURRENT_MEMBERSHIP_ID,
  OTHER_MEMBERSHIP_ID,
  TEST_HOME_A,
} from './test-stub.js';

describe('refresh home membership surfaces', () => {
  it('reconcileHomeMembershipSurfaces invalidates memberships and /me/homes', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    reconcileHomeMembershipSurfaces(queryClient, TEST_HOME_A);

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: homeMembershipsKeys.all(TEST_HOME_A),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: currentUserHomesQueryKey,
    });
  });

  it('patchCurrentUserHomeRole updates only the matching Home row', () => {
    const queryClient = new QueryClient();
    const otherHome: ActiveHome = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      name: 'Pine Avenue',
      timezone: 'UTC',
      hasPhoto: false,
      role: 'ADMIN',
    };
    queryClient.setQueryData(currentUserHomesQueryKey, [
      {
        id: TEST_HOME_A,
        name: 'Oak Street',
        timezone: 'UTC',
        hasPhoto: false,
        role: 'ADMIN',
      },
      otherHome,
    ]);

    patchCurrentUserHomeRole(queryClient, TEST_HOME_A, 'ROOMMATE');

    expect(queryClient.getQueryData(currentUserHomesQueryKey)).toEqual([
      {
        id: TEST_HOME_A,
        name: 'Oak Street',
        timezone: 'UTC',
        hasPhoto: false,
        role: 'ROOMMATE',
      },
      otherHome,
    ]);
  });

  it('removeMembershipFromHomeCache drops one roster row', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(homeMembershipsKeys.all(TEST_HOME_A), {
      currentMembershipId: CURRENT_MEMBERSHIP_ID,
      memberships: [
        { membershipId: CURRENT_MEMBERSHIP_ID, name: 'Alex' },
        { membershipId: OTHER_MEMBERSHIP_ID, name: 'Jamie' },
      ],
    });

    removeMembershipFromHomeCache(
      queryClient,
      TEST_HOME_A,
      OTHER_MEMBERSHIP_ID,
    );

    expect(queryClient.getQueryData(homeMembershipsKeys.all(TEST_HOME_A))).toEqual(
      {
        currentMembershipId: CURRENT_MEMBERSHIP_ID,
        memberships: [{ membershipId: CURRENT_MEMBERSHIP_ID, name: 'Alex' }],
      },
    );
  });

  it('removeMembershipFromHomeCache leaves undefined cache untouched', () => {
    const queryClient = new QueryClient();

    removeMembershipFromHomeCache(
      queryClient,
      TEST_HOME_A,
      OTHER_MEMBERSHIP_ID,
    );

    expect(
      queryClient.getQueryData(homeMembershipsKeys.all(TEST_HOME_A)),
    ).toBeUndefined();
  });
});
