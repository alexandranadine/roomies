import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../platform/api/index.js';
import { createHomeInvitation } from './create-invitation-api.js';

const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INVITATION_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createHomeInvitation', () => {
  it('POSTs email and parses the shareable invite URL contract', async () => {
    const payload = {
      invitation: {
        id: INVITATION_ID,
        email: 'jamie@example.com',
        expiresAt: '2026-10-01T12:00:00.000Z',
      },
      inviteUrl: `http://localhost:5173/invitations/${INVITATION_ID}#secret=share-secret`,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await createHomeInvitation({
      homeId: HOME_A,
      email: 'jamie@example.com',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe(`/api/v1/homes/${HOME_A}/invitations`);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(init.body).toBe(JSON.stringify({ email: 'jamie@example.com' }));
    expect(result).toEqual(payload);
  });

  it('rejects invitation payloads that omit inviteUrl', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            invitation: {
              id: INVITATION_ID,
              email: 'jamie@example.com',
              expiresAt: '2026-10-01T12:00:00.000Z',
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    await expect(
      createHomeInvitation({ homeId: HOME_A, email: 'jamie@example.com' }),
    ).rejects.toThrow();
  });
});
