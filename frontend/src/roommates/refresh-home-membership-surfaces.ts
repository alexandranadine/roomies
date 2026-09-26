import type { QueryClient } from '@tanstack/react-query';
import type { ActiveHomeMemberships } from '../homes/home-memberships-api.js';
import { homeMembershipsKeys } from '../homes/home-memberships-query-keys.js';
import {
  currentUserHomesQueryKey,
  homeContextQueryKey,
} from '../homes/home-query-keys.js';
import type { ActiveHome } from '../homes/homes-api.js';
import type { MembershipRole } from './change-membership-role-api.js';

/**
 * Background reconciliation after structural membership changes.
 * Does not invent a second cache-clearing system.
 */
export function reconcileHomeMembershipSurfaces(
  queryClient: QueryClient,
  homeId: string,
): void {
  void queryClient.invalidateQueries({
    queryKey: homeMembershipsKeys.all(homeId),
  });
  void queryClient.invalidateQueries({ queryKey: currentUserHomesQueryKey });
}

/** @deprecated Use reconcileHomeMembershipSurfaces. */
export function refreshHomeMembershipSurfaces(
  queryClient: QueryClient,
  homeId: string,
): void {
  reconcileHomeMembershipSurfaces(queryClient, homeId);
}

/**
 * After a confirmed current-user role change (204): patch /me/homes role
 * immediately so Admin controls do not linger until refetch.
 */
export function patchCurrentUserHomeRole(
  queryClient: QueryClient,
  homeId: string,
  role: MembershipRole,
): void {
  queryClient.setQueryData(
    currentUserHomesQueryKey,
    (homes: readonly ActiveHome[] | undefined) => {
      if (homes === undefined) {
        return homes;
      }
      return homes.map((home) =>
        home.id === homeId ? { ...home, role } : home,
      );
    },
  );
}

/**
 * After a confirmed remove (204): drop the membership from the cached roster
 * when the list shape is already loaded.
 */
export function removeMembershipFromHomeCache(
  queryClient: QueryClient,
  homeId: string,
  membershipId: string,
): void {
  queryClient.setQueryData(
    homeMembershipsKeys.all(homeId),
    (data: ActiveHomeMemberships | undefined) => {
      if (data === undefined) {
        return data;
      }
      return {
        ...data,
        memberships: data.memberships.filter(
          (row) => row.membershipId !== membershipId,
        ),
      };
    },
  );
}

/** Recover from concealed 404 / stale Membership without exposing authz detail. */
export async function recoverStaleHomeMembershipState(
  queryClient: QueryClient,
  homeId: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: homeMembershipsKeys.all(homeId),
    }),
    queryClient.invalidateQueries({ queryKey: currentUserHomesQueryKey }),
    queryClient.invalidateQueries({ queryKey: homeContextQueryKey(homeId) }),
  ]);
}
