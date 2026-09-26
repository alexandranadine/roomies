import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../platform/api/index.js';
import { renderApp } from '../test/render.js';

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
  requestReset?: (init?: RequestInit) => Response | Promise<Response>;
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
    if (path.includes('/api/auth/request-password-reset') && method === 'POST') {
      if (handlers.requestReset) {
        return handlers.requestReset(init);
      }
      return jsonResponse(200, {
        status: true,
        message: 'If this email exists in our system, check your email for the reset link',
      });
    }
    return jsonResponse(404, {
      error: { code: 'NOT_FOUND', message: 'Not found' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('forgot password page', () => {
  it('is linked from sign in', async () => {
    stubSignedOut();
    renderApp('/');
    await screen.findByRole('heading', { name: 'Welcome back', level: 1 });
    const link = screen.getByRole('link', { name: 'Forgot password?' });
    expect(link).toHaveAttribute('href', '/forgot-password');
  });

  it('renders the request form', async () => {
    stubSignedOut();
    renderApp('/forgot-password');
    expect(
      await screen.findByRole('heading', {
        name: 'Forgot your password?',
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/enter your email and we’ll send you a reset link/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /email/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Send reset link' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Back to sign in' }),
    ).toHaveAttribute('href', '/');
  });

  it('submits Better Auth request-password-reset and shows generic success', async () => {
    const fetchMock = stubSignedOut();
    renderApp('/forgot-password');
    await screen.findByRole('heading', { name: 'Forgot your password?' });
    await userEvent.type(
      screen.getByRole('textbox', { name: /email/i }),
      'roommate@example.com',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Send reset link' }),
    );

    expect(
      await screen.findByRole('heading', { name: 'Check your email', level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /if an account exists for that email, we've sent a password reset link/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/not found/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no account/i)).not.toBeInTheDocument();
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes('/api/auth/request-password-reset'),
        ),
      ).toBe(true);
    });
    const call = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/api/auth/request-password-reset'),
    );
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({
      email: 'roommate@example.com',
      redirectTo: `${window.location.origin}/reset-password`,
    });
  });

  it('uses the same success copy when Better Auth would not know the email', async () => {
    stubSignedOut({
      requestReset: () =>
        jsonResponse(200, {
          status: true,
          message: 'If this email exists in our system, check your email for the reset link',
        }),
    });
    renderApp('/forgot-password');
    await screen.findByRole('heading', { name: 'Forgot your password?' });
    await userEvent.type(
      screen.getByRole('textbox', { name: /email/i }),
      'unknown@example.com',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Send reset link' }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Check your email' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/this email exists in our system/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/user not found/i)).not.toBeInTheDocument();
  });

  it('renders a safe error when delivery fails', async () => {
    stubSignedOut({
      requestReset: () =>
        jsonResponse(500, {
          code: 'INTERNAL_ERROR',
          message: 'secret-provider-body token=abc',
        }),
    });
    renderApp('/forgot-password');
    await screen.findByRole('heading', { name: 'Forgot your password?' });
    await userEvent.type(
      screen.getByRole('textbox', { name: /email/i }),
      'roommate@example.com',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Send reset link' }),
    );
    expect(
      await screen.findByText(/couldn’t send a reset link/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/secret-provider-body/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/token=abc/i)).not.toBeInTheDocument();
  });
});
