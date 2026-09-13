import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../platform/api/index.js';
import { createHome } from './create-home-api.js';

const HOME_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const MEMBERSHIP_ID = '018f1e2c-7e3a-7000-8000-1234567890ac';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetApiClientForTests();
});

describe('createHome', () => {
  it('POSTs only name and timezone to /api/v1/homes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          home: {
            id: HOME_ID,
            name: 'Oak Street',
            timezone: 'America/Los_Angeles',
          },
          membership: { id: MEMBERSHIP_ID, role: 'ADMIN' },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await createHome({
      name: 'Oak Street',
      timezone: 'America/Los_Angeles',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/api/v1/homes');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(typeof init.body).toBe('string');
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'Oak Street',
      timezone: 'America/Los_Angeles',
    });
    expect(result).toEqual({
      home: {
        id: HOME_ID,
        name: 'Oak Street',
        timezone: 'America/Los_Angeles',
      },
      membership: { id: MEMBERSHIP_ID, role: 'ADMIN' },
    });
    expect(JSON.stringify(result)).not.toMatch(/owner|memberships|founder/i);
  });
});
