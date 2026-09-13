import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../platform/api/index.js';
import { listCurrentUserHomes } from './homes-api.js';

const HOME_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetApiClientForTests();
});

describe('listCurrentUserHomes', () => {
  it('GETs /api/v1/me/homes with credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: HOME_ID,
            name: 'Oak Street',
            timezone: 'America/Los_Angeles',
            role: 'ADMIN',
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await listCurrentUserHomes();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/api/v1/me/homes');
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.credentials).toBe('include');
    expect(result).toEqual([
      {
        id: HOME_ID,
        name: 'Oak Street',
        timezone: 'America/Los_Angeles',
        role: 'ADMIN',
      },
    ]);
  });
});
