import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../platform/api/index.js';
import { renderApp } from '../test/render.js';

const RESET_TOKEN = 'ResetToken1234567890abcd';

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubSignedOut(handlers: {
  reset?: (init?: RequestInit) => Response | Promise<Response>;
} = {}) {
  const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (path.endsWith('/api/v1/me') && method === 'GET') {
      return jsonResponse(401, {
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Authentication required',
        },
      });
    }
    if (path.includes('/api/auth/get-session')) {
      return new Response('null', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (path.includes('/api/auth/reset-password') && method === 'POST') {
      if (handlers.reset) {
        return handlers.reset(init);
      }
      return jsonResponse(200, { status: true });
    }
    return jsonResponse(404, {
      error: { code: 'NOT_FOUND', message: 'Not found' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('reset password page', () => {
  it('renders the reset form when a token is present', async () => {
    stubSignedOut();
    renderApp(`/reset-password?token=${RESET_TOKEN}`);
    expect(
      await screen.findByRole('heading', {
        name: 'Choose a new password',
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^new password/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^confirm new password/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Reset password' }),
    ).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(RESET_TOKEN);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('blocks password mismatch before calling Better Auth', async () => {
    const fetchMock = stubSignedOut();
    renderApp(`/reset-password?token=${RESET_TOKEN}`);
    await screen.findByRole('heading', { name: 'Choose a new password' });
    await userEvent.type(screen.getByLabelText(/^new password/i), 'test-password-only');
    await userEvent.type(
      screen.getByLabelText(/^confirm new password/i),
      'other-password-only',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Reset password' }));
    expect(await screen.findByText(/do not match/i)).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes('/api/auth/reset-password'),
      ),
    ).toBe(false);
  });

  it('calls native resetPassword and shows success', async () => {
    const fetchMock = stubSignedOut();
    renderApp(`/reset-password?token=${RESET_TOKEN}`);
    await screen.findByRole('heading', { name: 'Choose a new password' });
    await userEvent.type(
      screen.getByLabelText(/^new password/i),
      'replacement-password-ok',
    );
    await userEvent.type(
      screen.getByLabelText(/^confirm new password/i),
      'replacement-password-ok',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    expect(
      await screen.findByRole('heading', { name: 'Password reset', level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/sign in with your new password/i),
    ).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(RESET_TOKEN);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes('/api/auth/reset-password'),
        ),
      ).toBe(true);
    });
    const call = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/api/auth/reset-password'),
    );
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({
      token: RESET_TOKEN,
      newPassword: 'replacement-password-ok',
    });
  });

  it('shows the expired-link state when the token is missing', async () => {
    stubSignedOut();
    renderApp('/reset-password');
    expect(
      await screen.findByRole('heading', {
        name: 'This reset link is invalid or has expired.',
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Request a new link' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Back to sign in' }),
    ).toHaveAttribute('href', '/');
  });

  it('shows the expired-link state for Better Auth error redirects', async () => {
    stubSignedOut();
    renderApp('/reset-password?error=INVALID_TOKEN');
    expect(
      await screen.findByRole('heading', {
        name: 'This reset link is invalid or has expired.',
      }),
    ).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('INVALID_TOKEN');
  });

  it('maps an invalid token from resetPassword to the expired-link state', async () => {
    stubSignedOut({
      reset: () =>
        jsonResponse(400, {
          code: 'INVALID_TOKEN',
          message: 'Invalid token secret-body',
        }),
    });
    renderApp(`/reset-password?token=${RESET_TOKEN}`);
    await screen.findByRole('heading', { name: 'Choose a new password' });
    await userEvent.type(
      screen.getByLabelText(/^new password/i),
      'replacement-password-ok',
    );
    await userEvent.type(
      screen.getByLabelText(/^confirm new password/i),
      'replacement-password-ok',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Reset password' }));
    expect(
      await screen.findByRole('heading', {
        name: 'This reset link is invalid or has expired.',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/secret-body/i)).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(RESET_TOKEN);
  });
});
