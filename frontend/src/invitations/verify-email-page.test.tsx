import { screen } from '@testing-library/react';
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

describe('verify email page', () => {
  it('shows a verified state after Better Auth redirects back', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (String(url).includes('/api/auth/get-session')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                user: {
                  id: 'user-id',
                  email: 'roommate@example.com',
                  emailVerified: true,
                },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
          );
        }
        return Promise.resolve(new Response('{}', { status: 404 }));
      }),
    );

    renderApp('/verify-email');
    expect(
      await screen.findByRole('heading', {
        name: 'Email verified',
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/reopen the original invitation link/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Back to Roomies' }),
    ).toHaveAttribute('href', '/');
  });

  it('keeps verification failures generic', async () => {
    window.history.replaceState(null, '', '/verify-email?error=TOKEN_EXPIRED');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('null', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    renderApp('/verify-email?error=TOKEN_EXPIRED');
    expect(
      await screen.findByText(/this verification link isn’t valid/i),
    ).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('TOKEN_EXPIRED');
  });

  it('lets an unverified session resend from the return page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (String(url).includes('/api/auth/get-session')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                user: {
                  id: 'user-id',
                  email: 'roommate@example.com',
                  emailVerified: false,
                },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
          );
        }
        if (String(url).includes('/api/auth/send-verification-email')) {
          expect(init?.method).toBe('POST');
          return Promise.resolve(
            new Response(JSON.stringify({ status: true }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        }
        return Promise.resolve(new Response('{}', { status: 404 }));
      }),
    );

    renderApp('/verify-email');
    expect(
      await screen.findByRole('heading', {
        name: 'Check your email',
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('roommate@example.com')).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Resend verification email' }),
    );
    expect(
      await screen.findByText(/open the verification link we sent/i),
    ).toBeInTheDocument();
  });

  it('shows a calm resend failure without leaking provider details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (String(url).includes('/api/auth/get-session')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                user: {
                  id: 'user-id',
                  email: 'roommate@example.com',
                  emailVerified: false,
                },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
          );
        }
        if (String(url).includes('/api/auth/send-verification-email')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                code: 'INTERNAL_ERROR',
                message: 'secret-provider-body token=abc',
              }),
              { status: 500, headers: { 'Content-Type': 'application/json' } },
            ),
          );
        }
        return Promise.resolve(new Response('{}', { status: 404 }));
      }),
    );

    renderApp('/verify-email');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Resend verification email' }),
    );
    expect(
      await screen.findByText(/couldn’t send a verification email/i),
    ).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('secret-provider-body');
    expect(document.body.innerHTML).not.toContain('token=abc');
  });
});
