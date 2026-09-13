import type { QueryClient } from '@tanstack/react-query';
import { currentUserHomesQueryKey } from './home-query-keys.js';

/**
 * Drop private Home discovery and Home-scoped cache after authentication loss
 * or when the shell must not keep a previous Home visible.
 */
export function clearPrivateHomeQueryState(queryClient: QueryClient): void {
  queryClient.removeQueries({ queryKey: currentUserHomesQueryKey });
  queryClient.removeQueries({ queryKey: ['home'] });
}
