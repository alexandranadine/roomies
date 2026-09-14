import type { QueryClient } from '@tanstack/react-query';
import { notificationKeys } from '../notifications/notifications-query-keys.js';
import { currentUserHomesQueryKey } from './home-query-keys.js';

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
