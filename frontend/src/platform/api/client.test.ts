import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from './index.js';

describe('API client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends credentials for cookie auth readiness', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = createApiClient('http://localhost:3000');
    await client.request<{ ok: boolean }>({ path: '/api/v1/example' });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe('include');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://localhost:3000/api/v1/example',
    );
  });

  it('parses the backend error envelope into ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 'NOT_FOUND',
              message: 'Not found',
              requestId: 'req_123',
            },
          }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const client = createApiClient('http://localhost:3000');

    await expect(
      client.request({ path: '/api/v1/missing' }),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      code: 'NOT_FOUND',
      message: 'Not found',
      requestId: 'req_123',
    } satisfies Partial<ApiError>);
  });

  it('safely handles malformed or non-JSON error responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<html>gateway error</html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        }),
      ),
    );

    const client = createApiClient('http://localhost:3000');

    try {
      await client.request({ path: '/api/v1/whatever' });
      expect.fail('expected ApiError');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiError = err as ApiError;
      expect(apiError.status).toBe(502);
      expect(apiError.message).toBe('Request failed');
      expect(apiError.code).toBeUndefined();
      expect(apiError.requestId).toBeUndefined();
    }
  });
});
