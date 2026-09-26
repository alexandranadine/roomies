import type { QueryClient } from '@tanstack/react-query';
import { notificationKeys } from '../notifications/notifications-query-keys.js';
import {
  currentUserHomesQueryKey,
  currentUserQueryKey,
} from './home-query-keys.js';

/**
 * Drop private Home discovery, Home-scoped cache, and global Notifications
 * after authentication loss or when the shell must not keep prior private
 * data visible.
 */
export function clearPrivateHomeQueryState(queryClient: QueryClient): void {
  queryClient.removeQueries({ queryKey: currentUserHomesQueryKey });
  queryClient.removeQueries({ queryKey: ['home'] });
  queryClient.removeQueries({ queryKey: notificationKeys.all });
}

/**
 * Cache cleanup when a Home-scoped or global query establishes that the
 * current session is no longer authenticated. Clears private Home state and
 * resets `/me` (exact key) so identity data is absent immediately while
 * active RequireAuth observers refetch and surface 401.
 *
 * Uses reset rather than remove because removing an active `/me` query
 * prevents RequireAuth from refetching in place; reset clears cached identity
 * without leaving stale data during the background refetch.
 */
export function handlePassiveAuthLoss(queryClient: QueryClient): void {
  clearPrivateHomeQueryState(queryClient);
  void queryClient.resetQueries({ queryKey: currentUserQueryKey, exact: true });
}
