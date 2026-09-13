import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../platform/api/index.js';
import { renderApp } from '../test/render.js';
import {
  captureInvitationFragment,
  resetCapturedInvitationSecretForTests,
} from './capture-invitation-fragment.js';
import { invitationPreviewQueryKey } from './preview-api.js';

const INVITATION_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const HOME_NAME = 'Oak Street';
const EMAIL = 'roommate@example.com';

function previewBody() {
  return {
    invitation: {
      id: INVITATION_ID,
      email: EMAIL,
      expiresAt: '2026-10-08T00:00:00.000Z',
      home: {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: HOME_NAME,
      },
    },
  };
}

function stubPreview(status: number, body: unknown) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/api/auth/get-session')) {
      return Promise.resolve(
        new Response('null', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  resetCapturedInvitationSecretForTests();
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('invitation landing page', () => {
  it('renders safe Home name and email after capturing the fragment', async () => {
    window.history.replaceState(
      null,
      '',
      `/invitations/${INVITATION_ID}#secret=${SECRET}`,
    );
    captureInvitationFragment();
    expect(window.location.href).not.toContain(SECRET);

    const fetchMock = stubPreview(200, previewBody());
    const { queryClient } = renderApp(`/invitations/${INVITATION_ID}`);

    expect(
      await screen.findByRole('heading', {
        name: `You’re invited to ${HOME_NAME}`,
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(new RegExp(EMAIL))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join Home' })).toBeDisabled();
    expect(screen.getByText(/sign in to roomies/i)).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(document.querySelector('img')).toBeNull();
    expect(document.body.innerHTML).not.toMatch(/r2|photo|cloudflare/i);
    expect(JSON.stringify(localStorage)).not.toContain(SECRET);
    expect(JSON.stringify(sessionStorage)).not.toContain(SECRET);

    const keys = queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey);
    expect(keys).toContainEqual(invitationPreviewQueryKey(INVITATION_ID));
    expect(JSON.stringify(keys)).not.toContain(SECRET);

    const previewCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/preview'),
    ) as [string, RequestInit] | undefined;
    expect(previewCall).toBeDefined();
    if (previewCall === undefined) throw new Error('missing preview request');
    const [url, init] = previewCall;
    expect(url).toContain(`/api/v1/invitations/${INVITATION_ID}/preview`);
    expect(url).not.toContain(SECRET);
    expect(new Headers(init.headers).get('Authorization')).toBe(
      `Invitation ${SECRET}`,
    );
    expect(url.includes('/accept')).toBe(false);
  });

  it('renders a generic unavailable state', async () => {
    window.history.replaceState(
      null,
      '',
      `/invitations/${INVITATION_ID}#secret=${SECRET}`,
    );
    captureInvitationFragment();
    stubPreview(404, {
      error: {
        code: 'INVITATION_NOT_AVAILABLE',
        message: 'Invitation is not available',
      },
    });

    renderApp(`/invitations/${INVITATION_ID}`);

    expect(
      await screen.findByRole('heading', {
        name: 'Invitation unavailable',
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/isn’t available/i)).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(
      screen.queryByRole('button', { name: 'Join Home' }),
    ).not.toBeInTheDocument();
  });

  it('asks for the original link after a reload without a fragment', async () => {
    renderApp(`/invitations/${INVITATION_ID}`);

    expect(
      await screen.findByRole('heading', {
        name: 'Use the original invitation link',
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/use the original invitation link again/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Join Home' }),
    ).not.toBeInTheDocument();
  });

  it('announces a generic transient server error', async () => {
    window.history.replaceState(
      null,
      '',
      `/invitations/${INVITATION_ID}#secret=${SECRET}`,
    );
    captureInvitationFragment();
    stubPreview(500, {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      },
    });

    renderApp(`/invitations/${INVITATION_ID}`);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /couldn’t load this invitation/i,
    );
    expect(
      screen.getByRole('heading', { name: 'Invitation', level: 1 }),
    ).toBeInTheDocument();
  });

  it('works without a Roomies session cookie', async () => {
    window.history.replaceState(
      null,
      '',
      `/invitations/${INVITATION_ID}#secret=${SECRET}`,
    );
    captureInvitationFragment();
    const fetchMock = stubPreview(200, previewBody());

    renderApp(`/invitations/${INVITATION_ID}`);
    await screen.findByRole('heading', {
      name: `You’re invited to ${HOME_NAME}`,
    });

    const previewCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/preview'),
    ) as [string, RequestInit] | undefined;
    expect(previewCall).toBeDefined();
    if (previewCall === undefined) throw new Error('missing preview request');
    const [, init] = previewCall;
    const headers = new Headers(init.headers);
    expect(headers.get('Cookie')).toBeNull();
    expect(headers.has('Authorization')).toBe(true);
  });

  it('does not persist the secret while the landing query is in flight', async () => {
    window.history.replaceState(
      null,
      '',
      `/invitations/${INVITATION_ID}#secret=${SECRET}`,
    );
    captureInvitationFragment();
    stubPreview(200, previewBody());
    renderApp(`/invitations/${INVITATION_ID}`);
    await waitFor(() => {
      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
    });
  });

  it('lets a signed-in matching verified user accept without persisting the secret', async () => {
    window.history.replaceState(
      null,
      '',
      `/invitations/${INVITATION_ID}#secret=${SECRET}`,
    );
    captureInvitationFragment();
    const homeId = previewBody().invitation.home.id;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/auth/get-session')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              user: {
                id: '11111111-1111-4111-8111-111111111111',
                email: EMAIL,
                emailVerified: true,
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url.includes('/accept')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              membershipId: '018f1e2c-7e3a-7000-8000-1234567890ac',
              homeId,
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(previewBody()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient, router } = renderApp(`/invitations/${INVITATION_ID}`);
    const join = await screen.findByRole('button', { name: 'Join Home' });
    expect(join).toBeEnabled();
    await userEvent.click(join);

    await waitFor(() => {
      expect(window.location.href).not.toContain(SECRET);
      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
    });
    const acceptCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/accept'),
    ) as [string, RequestInit] | undefined;
    expect(acceptCall).toBeDefined();
    if (acceptCall === undefined) throw new Error('missing acceptance request');
    const [acceptUrl, acceptInit] = acceptCall;
    expect(acceptUrl).not.toContain(SECRET);
    expect(new Headers(acceptInit.headers).get('Authorization')).toBe(
      `Invitation ${SECRET}`,
    );
    expect(acceptInit.body).toBe('{}');
    expect(
      queryClient.getQueryData(invitationPreviewQueryKey(INVITATION_ID)),
    ).toBeUndefined();
    expect(router.state.location.pathname).toBe(`/homes/${homeId}`);
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it('does not attempt acceptance for wrong or unverified session email', async () => {
    for (const user of [
      { email: 'other@example.com', emailVerified: true },
      { email: EMAIL, emailVerified: false },
    ]) {
      resetCapturedInvitationSecretForTests();
      captureInvitationFragment(
        {
          pathname: `/invitations/${INVITATION_ID}`,
          search: '',
          hash: `#secret=${SECRET}`,
        },
        window.history,
      );
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        const value = url.includes('/api/auth/get-session')
          ? { user: { id: 'user-id', ...user } }
          : previewBody();
        return Promise.resolve(
          new Response(JSON.stringify(value), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      });
      vi.stubGlobal('fetch', fetchMock);
      const rendered = renderApp(`/invitations/${INVITATION_ID}`);
      expect(
        await screen.findByRole('button', { name: 'Join Home' }),
      ).toBeDisabled();
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes('/accept')),
      ).toBe(false);
      rendered.unmount();
    }
  });
});
