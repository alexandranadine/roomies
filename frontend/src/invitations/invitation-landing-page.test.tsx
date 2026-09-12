import { screen, waitFor } from '@testing-library/react';
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
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
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
    expect(screen.getByText(/isn’t available yet/i)).toBeInTheDocument();
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

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
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

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
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
});
