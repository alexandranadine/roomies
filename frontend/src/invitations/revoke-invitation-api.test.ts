import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../platform/api/index.js';
import { revokeHomeInvitation } from './revoke-invitation-api.js';

const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INVITATION_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('revokeHomeInvitation', () => {
  it('POSTs an empty body to the existing revoke contract', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await revokeHomeInvitation({
      homeId: HOME_A,
      invitationId: INVITATION_ID,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe(
      `/api/v1/homes/${HOME_A}/invitations/${INVITATION_ID}/revoke`,
    );
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(init.body).toBe(JSON.stringify({}));
  });
});
