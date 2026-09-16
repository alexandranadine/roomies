import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, resetApiClientForTests } from '../platform/api/index.js';
import { deleteAccount } from './delete-account-api.js';

describe('deleteAccount API', () => {
  afterEach(() => {
    resetApiClientForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends DELETE /api/v1/account with exact confirmation body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await deleteAccount('DELETE');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toMatch(/\/api\/v1\/account$/);
    expect(init.method).toBe('DELETE');
    expect(init.credentials).toBe('include');
    expect(typeof init.body).toBe('string');
    expect(JSON.parse(init.body as string)).toEqual({ confirmation: 'DELETE' });
  });

  it('maps LAST_ADMIN_REQUIRED through ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 'LAST_ADMIN_REQUIRED',
              message: 'Last admin required',
            },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    await expect(deleteAccount('DELETE')).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      code: 'LAST_ADMIN_REQUIRED',
    } satisfies Partial<ApiError>);
  });

  it('does not invent a success DTO for 204', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    );

    await expect(deleteAccount('DELETE')).resolves.toBeUndefined();
  });
});
