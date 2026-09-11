import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/api-error.js';
import {
  createAppQueryClient,
  QUERY_MAX_RETRIES,
  QUERY_STALE_TIME_MS,
  shouldRetryQuery,
} from './query-client.js';

describe('QueryClient defaults', () => {
  it('does not retry mutations by default', async () => {
    const queryClient = createAppQueryClient();
    const mutationFn = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(
      queryClient
        .getMutationCache()
        .build(queryClient, {
          mutationFn,
        })
        .execute({}),
    ).rejects.toThrow('boom');

    expect(mutationFn).toHaveBeenCalledTimes(1);

    const defaults = queryClient.getDefaultOptions();
    expect(defaults.mutations?.retry).toBe(false);
  });

  it('does not configure cache persistence or an offline mutation queue', () => {
    const queryClient = createAppQueryClient();
    const defaults = queryClient.getDefaultOptions();

    expect(defaults.queries?.staleTime).toBe(QUERY_STALE_TIME_MS);
    expect(defaults.queries?.networkMode).toBe('online');
    expect(defaults.mutations?.networkMode).toBe('online');
    expect(defaults.mutations?.retry).toBe(false);

    // No persister / dehydrate hooks are attached at construction time.
    expect(
      (queryClient as unknown as { persister?: unknown }).persister,
    ).toBeUndefined();
  });

  it('applies the conservative query retry policy', () => {
    expect(shouldRetryQuery(0, new Error('network'))).toBe(true);
    expect(shouldRetryQuery(1, new Error('network'))).toBe(true);
    expect(shouldRetryQuery(QUERY_MAX_RETRIES, new Error('network'))).toBe(
      false,
    );

    const apiError = new ApiError({
      status: 503,
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    });
    expect(shouldRetryQuery(0, apiError)).toBe(false);

    const client = createAppQueryClient();
    const retry = client.getDefaultOptions().queries?.retry;
    expect(typeof retry).toBe('function');
    if (typeof retry === 'function') {
      expect(retry(0, new Error('network'))).toBe(true);
      expect(retry(0, apiError)).toBe(false);
      expect(retry(QUERY_MAX_RETRIES, new Error('network'))).toBe(false);
    }
  });
});
