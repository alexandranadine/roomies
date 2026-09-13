import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../platform/api/index.js';
import { getHomeContext } from './home-context-api.js';

const HOME_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetApiClientForTests();
});

describe('getHomeContext', () => {
  it('GETs the authorized Home identity for the URL Home', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: HOME_ID,
          name: 'Oak Street',
          timezone: 'America/Los_Angeles',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await getHomeContext(HOME_ID);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe(`/api/v1/homes/${HOME_ID}`);
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.credentials).toBe('include');
    expect(result).toEqual({
      id: HOME_ID,
      name: 'Oak Street',
      timezone: 'America/Los_Angeles',
    });
  });
});
