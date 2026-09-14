import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, resetApiClientForTests } from '../platform/api/index.js';
import { createAppQueryClient } from '../platform/query/query-client.js';
import { activityKeys } from './activity-query-keys.js';
import {
  FIXTURE_HOME_B_TASK,
  FIXTURE_TASK_TITLED,
  listPage,
  notFoundBody,
  TEST_HOME_A,
  TEST_HOME_B,
  TEST_MEMBERSHIP_ALEX,
  TEST_USER_ID,
  unauthenticatedBody,
} from './test-fixtures.js';
import { stubActivityApis } from './test-stub.js';
import { useActivityList } from './use-activity-list.js';

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function createWrapper() {
  const queryClient = createAppQueryClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  }
  return { queryClient, Wrapper };
}

describe('useActivityList', () => {
  it('fetches the first Activity page without a cursor', async () => {
    const fetchMock = stubActivityApis({
      listByHome: {
        [TEST_HOME_A]: listPage([FIXTURE_TASK_TITLED]),
      },
    });
    const { Wrapper } = createWrapper();
    const { result } = renderHook(
      () => useActivityList({ homeId: TEST_HOME_A }),
      {
        wrapper: Wrapper,
      },
    );

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data?.pages[0]?.items).toEqual([FIXTURE_TASK_TITLED]);
    const firstCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('/activity'),
    );
    expect(firstCall).toBeDefined();
    const parsed = new URL(String(firstCall?.[0]));
    expect(parsed.searchParams.has('cursor')).toBe(false);
    expect(parsed.searchParams.has('limit')).toBe(false);
  });

  it('sends cursor only when loading a later page', async () => {
    const fetchMock = stubActivityApis({
      listByHome: {
        [TEST_HOME_A]: (url) => {
          const cursor = url.searchParams.get('cursor');
          if (cursor === 'cursor-page-2') {
            return listPage([], { hasMore: false, nextCursor: null });
          }
          return listPage([FIXTURE_TASK_TITLED], {
            hasMore: true,
            nextCursor: 'cursor-page-2',
          });
        },
      },
    });
    const { Wrapper } = createWrapper();
    const { result } = renderHook(
      () => useActivityList({ homeId: TEST_HOME_A }),
      {
        wrapper: Wrapper,
      },
    );

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
      expect(result.current.hasNextPage).toBe(true);
    });

    const next = await act(() => result.current.fetchNextPage());

    expect(next.isError).toBe(false);
    expect(next.data?.pages).toHaveLength(2);

    const laterCalls = fetchMock.mock.calls.filter((call) => {
      const url = new URL(String(call[0]));
      return url.searchParams.get('cursor') === 'cursor-page-2';
    });
    expect(laterCalls.length).toBe(1);
    const laterUrl = new URL(String(laterCalls[0]?.[0]));
    expect([...laterUrl.searchParams.keys()]).toEqual(['cursor']);
  });

  it('scopes Home A and Home B to different query keys', async () => {
    stubActivityApis({
      listByHome: {
        [TEST_HOME_A]: listPage([FIXTURE_TASK_TITLED]),
        [TEST_HOME_B]: listPage([FIXTURE_HOME_B_TASK]),
      },
    });
    const { queryClient, Wrapper } = createWrapper();

    const first = renderHook(() => useActivityList({ homeId: TEST_HOME_A }), {
      wrapper: Wrapper,
    });
    await waitFor(() => {
      expect(first.result.current.isSuccess).toBe(true);
    });

    const second = renderHook(() => useActivityList({ homeId: TEST_HOME_B }), {
      wrapper: Wrapper,
    });
    await waitFor(() => {
      expect(second.result.current.isSuccess).toBe(true);
    });

    expect(activityKeys.list(TEST_HOME_A)).not.toEqual(
      activityKeys.list(TEST_HOME_B),
    );
    expect(
      queryClient.getQueryData(activityKeys.list(TEST_HOME_A)),
    ).toBeDefined();
    expect(
      queryClient.getQueryData(activityKeys.list(TEST_HOME_B)),
    ).toBeDefined();
    expect(first.result.current.data?.pages[0]?.items[0]?.id).toBe(
      FIXTURE_TASK_TITLED.id,
    );
    expect(second.result.current.data?.pages[0]?.items[0]?.id).toBe(
      FIXTURE_HOME_B_TASK.id,
    );
  });

  it('does not send user, membership, role, or privacy params', async () => {
    const fetchMock = stubActivityApis({
      listByHome: {
        [TEST_HOME_A]: listPage([FIXTURE_TASK_TITLED]),
      },
    });
    const { Wrapper } = createWrapper();
    const { result } = renderHook(
      () => useActivityList({ homeId: TEST_HOME_A }),
      {
        wrapper: Wrapper,
      },
    );

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    for (const call of fetchMock.mock.calls) {
      const url = new URL(String(call[0]));
      if (!url.pathname.endsWith('/activity')) {
        continue;
      }
      expect(url.searchParams.has('userId')).toBe(false);
      expect(url.searchParams.has('membershipId')).toBe(false);
      expect(url.searchParams.has('role')).toBe(false);
      expect(url.searchParams.has('visibilityClass')).toBe(false);
      expect(url.search).not.toContain(TEST_USER_ID);
      expect(url.search).not.toContain(TEST_MEMBERSHIP_ALEX);
    }
  });

  it('surfaces 401 as an ApiError', async () => {
    stubActivityApis({
      listByHome: {
        [TEST_HOME_A]: () => ({ status: 401, body: unauthenticatedBody() }),
      },
    });
    const { Wrapper } = createWrapper();
    const { result } = renderHook(
      () => useActivityList({ homeId: TEST_HOME_A }),
      {
        wrapper: Wrapper,
      },
    );

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as ApiError).status).toBe(401);
  });

  it('surfaces 404 as an ApiError', async () => {
    stubActivityApis({
      listByHome: {
        [TEST_HOME_A]: () => ({ status: 404, body: notFoundBody() }),
      },
    });
    const { Wrapper } = createWrapper();
    const { result } = renderHook(
      () => useActivityList({ homeId: TEST_HOME_A }),
      {
        wrapper: Wrapper,
      },
    );

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as ApiError).status).toBe(404);
  });
});
