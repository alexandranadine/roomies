import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../platform/api/index.js';
import { createAppQueryClient } from '../platform/query/query-client.js';
import { pulseKeys } from './pulse-query-keys.js';
import {
  activeHousePulse,
  clearHousePulse,
  TEST_HOME_A,
} from './test-fixtures.js';
import { stubPulseApis } from './test-stub.js';
import { useHousePulse } from './use-house-pulse.js';

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

describe('useHousePulse', () => {
  it('uses a Home-scoped key with no polling or persistence', async () => {
    localStorage.clear();
    sessionStorage.clear();
    const fetchMock = stubPulseApis({
      pulseByHome: { [TEST_HOME_A]: activeHousePulse() },
    });
    const { queryClient, Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useHousePulse({ homeId: TEST_HOME_A }),
      {
        wrapper: Wrapper,
      },
    );

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(activeHousePulse());
    expect(pulseKeys.all(TEST_HOME_A)).toEqual(['home', TEST_HOME_A, 'pulse']);
    expect(queryClient.getQueryState(pulseKeys.all(TEST_HOME_A))).toBeDefined();

    const observed = queryClient.getQueryCache().find({
      queryKey: pulseKeys.all(TEST_HOME_A),
    });
    expect(
      (observed?.options as { refetchInterval?: false | number })
        .refetchInterval,
    ).toBe(false);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);

    const pulseCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/pulse'),
    );
    expect(pulseCalls.length).toBeGreaterThanOrEqual(1);
    expect(new URL(String(pulseCalls[0]?.[0])).pathname).toBe(
      `/api/v1/homes/${TEST_HOME_A}/pulse`,
    );
  });

  it('does not enable the query without a homeId', () => {
    stubPulseApis({ pulseByHome: { [TEST_HOME_A]: clearHousePulse() } });
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useHousePulse({ homeId: '' }), {
      wrapper: Wrapper,
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(result.current.isFetching).toBe(false);
  });
});
