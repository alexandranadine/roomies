import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/api-error.js';

/** ~30s stale time for server-backed reads. */
export const QUERY_STALE_TIME_MS = 30_000;

/** Cap query retries for transient transport failures. */
export const QUERY_MAX_RETRIES = 2;

/**
 * Conservative query retry policy.
 *
 * At foundation stage we do not have a rich enough classifier to safely decide
 * which HTTP failures are transient. Therefore:
 * - Never retry `ApiError` (covers 4xx, auth, validation, hidden-resource 404s,
 *   and 5xx responses that already reached the client as structured errors).
 * - Retry only non-ApiError failures (typically network/transport errors), up
 *   to {@link QUERY_MAX_RETRIES} times.
 *
 * Mutations never retry by default.
 *
 * No query cache persistence and no offline mutation queue are configured.
 */
export function shouldRetryQuery(
  failureCount: number,
  error: unknown,
): boolean {
  if (failureCount >= QUERY_MAX_RETRIES) {
    return false;
  }
  if (error instanceof ApiError) {
    return false;
  }
  return true;
}

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: QUERY_STALE_TIME_MS,
        retry: shouldRetryQuery,
        // Explicit: online-only; no offline queue.
        networkMode: 'online',
      },
      mutations: {
        retry: false,
        networkMode: 'online',
      },
    },
  });
}
