import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../platform/api/index.js';
import { createAppQueryClient } from '../platform/query/query-client.js';
import { homePhotoQueryKey } from './home-query-keys.js';
import { useHomePhoto } from './use-home-photo.js';

const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SIGNED_GET =
  'https://abc123.r2.cloudflarestorage.com/canonical/get?X-Amz-Signature=redacted';

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

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

describe('useHomePhoto', () => {
  it('does not request /photo when hasPhoto is false', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useHomePhoto({ homeId: HOME_ID, hasPhoto: false }),
      { wrapper: Wrapper },
    );

    expect(result.current.fetchStatus).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches a Blob when hasPhoto is true', async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const path = String(url);
      if (path.includes(`/api/v1/homes/${HOME_ID}/photo`)) {
        return Promise.resolve(
          jsonResponse(200, {
            downloadUrl: SIGNED_GET,
            contentType: 'image/webp',
            expiresAt: '2026-09-24T00:01:00.000Z',
          }),
        );
      }
      if (path === SIGNED_GET) {
        return Promise.resolve(new Response(bytes, { status: 200 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { queryClient, Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useHomePhoto({ homeId: HOME_ID, hasPhoto: true }),
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toBeInstanceOf(Blob);
    expect(result.current.data?.size).toBe(3);
    expect(queryClient.getQueryData(homePhotoQueryKey(HOME_ID))).toBeInstanceOf(
      Blob,
    );
    expect(
      JSON.stringify(queryClient.getQueryData(homePhotoQueryKey(HOME_ID))),
    ).not.toContain(SIGNED_GET);
  });
});
