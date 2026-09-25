import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../platform/api/index.js';
import {
  changeMembershipRole,
  type MembershipRole,
} from './change-membership-role-api.js';
import { leaveHome } from './leave-home-api.js';
import { removeRoommate } from './remove-roommate-api.js';
import {
  CURRENT_MEMBERSHIP_ID,
  emptyResponse,
  errorBody,
  jsonResponse,
  TEST_HOME_A,
} from './test-stub.js';

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('membership action APIs', () => {
  it('PATCHes role with the frozen body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(emptyResponse(204));
    vi.stubGlobal('fetch', fetchMock);

    await changeMembershipRole({
      homeId: TEST_HOME_A,
      membershipId: CURRENT_MEMBERSHIP_ID,
      role: 'ADMIN' satisfies MembershipRole,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe(
      `/api/v1/homes/${TEST_HOME_A}/memberships/${CURRENT_MEMBERSHIP_ID}/role`,
    );
    expect(init.method).toBe('PATCH');
    expect(init.credentials).toBe('include');
    expect(init.body).toBe(JSON.stringify({ role: 'ADMIN' }));
  });

  it('POSTs leave with an empty object body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(emptyResponse(204));
    vi.stubGlobal('fetch', fetchMock);

    await leaveHome({
      homeId: TEST_HOME_A,
      membershipId: CURRENT_MEMBERSHIP_ID,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe(
      `/api/v1/homes/${TEST_HOME_A}/memberships/${CURRENT_MEMBERSHIP_ID}/leave`,
    );
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({}));
  });

  it('POSTs remove with an empty object body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(emptyResponse(204));
    vi.stubGlobal('fetch', fetchMock);

    await removeRoommate({
      homeId: TEST_HOME_A,
      membershipId: CURRENT_MEMBERSHIP_ID,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe(
      `/api/v1/homes/${TEST_HOME_A}/memberships/${CURRENT_MEMBERSHIP_ID}/remove`,
    );
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({}));
  });

  it('maps LAST_ADMIN_REQUIRED through ApiError without leaking internals', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            409,
            errorBody('LAST_ADMIN_REQUIRED', 'Last admin required'),
          ),
        ),
    );

    await expect(
      changeMembershipRole({
        homeId: TEST_HOME_A,
        membershipId: CURRENT_MEMBERSHIP_ID,
        role: 'ROOMMATE',
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'LAST_ADMIN_REQUIRED',
    });
  });
});
