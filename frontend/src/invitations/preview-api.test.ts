import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../platform/api/index.js';
import { invitationPreviewQueryKey, previewInvitation } from './preview-api.js';

const INVITATION_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetApiClientForTests();
});

describe('previewInvitation', () => {
  it('sends Authorization: Invitation for that request only and keeps the secret out of the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          invitation: {
            id: INVITATION_ID,
            email: 'roommate@example.com',
            expiresAt: '2026-10-08T00:00:00.000Z',
            home: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Oak' },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await previewInvitation({ invitationId: INVITATION_ID, secret: SECRET });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `http://localhost:3000/api/v1/invitations/${INVITATION_ID}/preview`,
    );
    expect(url).not.toContain(SECRET);
    expect(url).not.toContain('secret=');
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe(`Invitation ${SECRET}`);
    expect(init.credentials).toBe('include');
    expect(invitationPreviewQueryKey(INVITATION_ID)).toEqual([
      'invitation-preview',
      INVITATION_ID,
    ]);
    expect(
      JSON.stringify(invitationPreviewQueryKey(INVITATION_ID)),
    ).not.toContain(SECRET);
  });
});
