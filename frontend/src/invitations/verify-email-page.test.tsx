import { screen } from '@testing-library/react';
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
      await screen.findByText(/your email is verified/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        name: 'Verify your email',
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/reopen the original invitation link/i),
    ).toBeInTheDocument();
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
});
