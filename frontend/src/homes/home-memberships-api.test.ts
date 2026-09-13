import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../platform/api/index.js';
import {
  activeHomeMembershipsSchema,
  listHomeMemberships,
} from './home-memberships-api.js';
import { homeMembershipsKeys } from './home-memberships-query-keys.js';

const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CURRENT = 'm1111111-1111-4111-8111-111111111111';
const OTHER = 'm2222222-2222-4222-8222-222222222222';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetApiClientForTests();
});

describe('home memberships API', () => {
  it('GETs Home-scoped memberships with credentials', async () => {
    const payload = {
      currentMembershipId: CURRENT,
      memberships: [
        { membershipId: CURRENT, name: 'Alex' },
        { membershipId: OTHER, name: 'Jamie' },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, payload));
    vi.stubGlobal('fetch', fetchMock);

    const result = await listHomeMemberships(HOME_A);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe(`/api/v1/homes/${HOME_A}/memberships`);
    expect(init.credentials).toBe('include');
    expect(result).toEqual(payload);
    expect(activeHomeMembershipsSchema.safeParse(result).success).toBe(true);
  });

  it('rejects broadened membership DTOs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        currentMembershipId: CURRENT,
        memberships: [
          {
            membershipId: CURRENT,
            name: 'Alex',
            role: 'ADMIN',
            email: 'alex@example.com',
            userId: 'u1',
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(listHomeMemberships(HOME_A)).rejects.toThrow();
  });
});

describe('home memberships query keys', () => {
  it('scopes memberships by homeId and isolates Homes', () => {
    expect(homeMembershipsKeys.all(HOME_A)).toEqual([
      'home',
      HOME_A,
      'memberships',
    ]);
    expect(homeMembershipsKeys.all(HOME_A)).not.toEqual(
      homeMembershipsKeys.all(HOME_B),
    );
    expect(homeMembershipsKeys.all(HOME_A)[1]).toBe(HOME_A);
  });
});
