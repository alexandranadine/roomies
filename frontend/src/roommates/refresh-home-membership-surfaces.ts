import type { QueryClient } from '@tanstack/react-query';
import { homeMembershipsKeys } from '../homes/home-memberships-query-keys.js';
import {
  currentUserHomesQueryKey,
  homeContextQueryKey,
} from '../homes/home-query-keys.js';

/**
 * Refresh active Memberships and current-Home role after a structural change.
 * Does not invent a second cache-clearing system.
 */
export async function refreshHomeMembershipSurfaces(
  queryClient: QueryClient,
  homeId: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: homeMembershipsKeys.all(homeId),
    }),
    queryClient.invalidateQueries({ queryKey: currentUserHomesQueryKey }),
  ]);
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
