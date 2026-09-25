import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../platform/api/index.js';
import { renderApp } from '../test/render.js';

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('credential form', () => {
  it('signs in from the unauthenticated landing and refreshes /me', async () => {
    let authenticated = false;
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string, init?: RequestInit) => {
        const path = String(url);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (path.endsWith('/api/v1/me') && method === 'GET') {
          if (!authenticated) {
            return Promise.resolve(
              jsonResponse(401, {
                error: {
                  code: 'UNAUTHENTICATED',
                  message: 'Authentication required',
                },
              }),
            );
          }
          return Promise.resolve(
            jsonResponse(200, {
              id: '11111111-1111-4111-8111-111111111111',
            }),
          );
        }
        if (path.includes('/api/auth/sign-in/email') && method === 'POST') {
          authenticated = true;
          return Promise.resolve(
            jsonResponse(200, { token: 'session', user: { id: 'user-id' } }),
          );
        }
        if (path.includes('/api/auth/get-session')) {
          return Promise.resolve(
            jsonResponse(200, {
              user: {
                id: 'user-id',
                email: 'roommate@example.com',
                emailVerified: true,
              },
            }),
          );
        }
        if (path.endsWith('/api/v1/me/homes')) {
          return Promise.resolve(jsonResponse(200, []));
        }
        return Promise.resolve(
          jsonResponse(404, {
            error: { code: 'NOT_FOUND', message: 'Not found' },
          }),
        );
      });
    vi.stubGlobal('fetch', fetchMock);
    renderApp('/');

    expect(
      await screen.findByText(/sign in to see your homes/i),
    ).toBeInTheDocument();
    await userEvent.type(
      screen.getByRole('textbox', { name: /email/i }),
      'roommate@example.com',
    );
    await userEvent.type(
      screen.getByLabelText(/password/i),
      'test-password-only',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(
      await screen.findByRole('heading', { name: 'Your Homes', level: 1 }),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes('/api/auth/sign-in/email'),
      ),
    ).toBe(true);
  });

  it('shows a useful unverified message after sign-up', async () => {
    let authenticated = false;
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string, init?: RequestInit) => {
        const path = String(url);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (path.endsWith('/api/v1/me') && method === 'GET') {
          if (!authenticated) {
            return Promise.resolve(
              jsonResponse(401, {
                error: {
                  code: 'UNAUTHENTICATED',
                  message: 'Authentication required',
                },
              }),
            );
          }
          return Promise.resolve(
            jsonResponse(200, {
              id: '11111111-1111-4111-8111-111111111111',
            }),
          );
        }
        if (path.includes('/api/auth/sign-up/email') && method === 'POST') {
          authenticated = true;
          const rawBody = init?.body;
          if (typeof rawBody === 'string') {
            const parsed: unknown = JSON.parse(rawBody);
            expect(parsed).toEqual(
              expect.objectContaining({
                callbackURL: `${window.location.origin}/verify-email`,
              }),
            );
          }
          return Promise.resolve(
            jsonResponse(200, { token: 'session', user: { id: 'user-id' } }),
          );
        }
        if (path.includes('/api/auth/get-session')) {
          return Promise.resolve(
            jsonResponse(200, {
              user: {
                id: 'user-id',
                email: 'roommate@example.com',
                emailVerified: false,
              },
            }),
          );
        }
        if (path.endsWith('/api/v1/me/homes')) {
          return Promise.resolve(jsonResponse(200, []));
        }
        return Promise.resolve(
          jsonResponse(404, {
            error: { code: 'NOT_FOUND', message: 'Not found' },
          }),
        );
      });
    vi.stubGlobal('fetch', fetchMock);
    renderApp('/');

    await screen.findByText(/sign in to see your homes/i);
    await userEvent.click(screen.getByRole('button', { name: 'New account' }));
    await userEvent.type(
      screen.getByRole('textbox', { name: /name/i }),
      'Alex',
    );
    await userEvent.type(
      screen.getByRole('textbox', { name: /email/i }),
      'roommate@example.com',
    );
    await userEvent.type(
      screen.getByLabelText(/password/i),
      'test-password-only',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Create account' }),
    );

    expect(
      await screen.findByText(/verify your email before joining this home/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Send verification email' }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Your Homes', level: 1 }),
      ).toBeInTheDocument();
    });
  });
});
