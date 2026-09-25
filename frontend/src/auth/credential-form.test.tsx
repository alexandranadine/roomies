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

function stubUnauthenticatedLanding(handlers: {
  signIn?: (init?: RequestInit) => Response | Promise<Response>;
  signUp?: (init?: RequestInit) => Response | Promise<Response>;
  afterAuth?: {
    emailVerified?: boolean;
  };
}) {
  let authenticated = false;
  const fetchMock = vi
    .fn()
    .mockImplementation(async (url: string, init?: RequestInit) => {
      const path = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (path.endsWith('/api/v1/me') && method === 'GET') {
        if (!authenticated) {
          return jsonResponse(401, {
            error: {
              code: 'UNAUTHENTICATED',
              message: 'Authentication required',
            },
          });
        }
        return jsonResponse(200, {
          id: '11111111-1111-4111-8111-111111111111',
        });
      }
      if (path.includes('/api/auth/sign-in/email') && method === 'POST') {
        if (handlers.signIn) {
          const response = await Promise.resolve(handlers.signIn(init));
          if (response.ok) {
            authenticated = true;
          }
          return response;
        }
        authenticated = true;
        return jsonResponse(200, { token: 'session', user: { id: 'user-id' } });
      }
      if (path.includes('/api/auth/sign-up/email') && method === 'POST') {
        if (handlers.signUp) {
          const response = await Promise.resolve(handlers.signUp(init));
          if (response.ok) {
            authenticated = true;
          }
          return response;
        }
        authenticated = true;
        return jsonResponse(200, { token: 'session', user: { id: 'user-id' } });
      }
      if (path.includes('/api/auth/get-session')) {
        if (!authenticated) {
          return Promise.resolve(
            new Response('null', {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        }
        return Promise.resolve(
          jsonResponse(200, {
            user: {
              id: 'user-id',
              email: 'roommate@example.com',
              emailVerified: handlers.afterAuth?.emailVerified ?? true,
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
  return fetchMock;
}

describe('credential form', () => {
  it('renders sign-in fields and the create-account control', async () => {
    stubUnauthenticatedLanding({});
    renderApp('/');

    expect(
      await screen.findByRole('heading', { name: 'Welcome back', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText('Sign in to your home.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /email/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create an account' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('textbox', { name: /name/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /notifications/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Account' }),
    ).not.toBeInTheDocument();
  });

  it('navigates to sign-up and back to sign-in without inventing fields', async () => {
    stubUnauthenticatedLanding({});
    renderApp('/');

    await screen.findByRole('heading', { name: 'Welcome back', level: 1 });
    await userEvent.click(
      screen.getByRole('button', { name: 'Create an account' }),
    );

    expect(
      screen.getByRole('heading', {
        name: 'Create your account',
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/start a home or join one you’ve been invited to/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /name/i })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /email/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create account' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(
      screen.getByRole('heading', { name: 'Welcome back', level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('textbox', { name: /name/i }),
    ).not.toBeInTheDocument();
  });

  it('validates required sign-in fields before calling the API', async () => {
    const fetchMock = stubUnauthenticatedLanding({});
    renderApp('/');
    await screen.findByRole('heading', { name: 'Welcome back', level: 1 });
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Enter an email address.')).toBeInTheDocument();
    expect(screen.getByText('Enter a password.')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes('/api/auth/sign-in/email'),
      ),
    ).toBe(false);
  });

  it('validates required sign-up fields before calling the API', async () => {
    const fetchMock = stubUnauthenticatedLanding({});
    renderApp('/');
    await screen.findByRole('heading', { name: 'Welcome back', level: 1 });
    await userEvent.click(
      screen.getByRole('button', { name: 'Create an account' }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Create account' }),
    );

    expect(await screen.findByText('Enter your name.')).toBeInTheDocument();
    expect(screen.getByText('Enter an email address.')).toBeInTheDocument();
    expect(screen.getByText('Enter a password.')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes('/api/auth/sign-up/email'),
      ),
    ).toBe(false);
  });

  it('shows a generic invalid-credentials error', async () => {
    stubUnauthenticatedLanding({
      signIn: () =>
        jsonResponse(401, {
          code: 'INVALID_EMAIL_OR_PASSWORD',
          message: 'Invalid email or password secret-body',
        }),
    });
    renderApp('/');

    await screen.findByRole('heading', { name: 'Welcome back', level: 1 });
    await userEvent.type(
      screen.getByRole('textbox', { name: /email/i }),
      'roommate@example.com',
    );
    await userEvent.type(
      screen.getByLabelText(/password/i),
      'wrong-password',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(
      await screen.findByText('Email or password is incorrect.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/secret-body/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Welcome back', level: 1 }),
    ).toBeInTheDocument();
  });

  it('maps duplicate email without exposing account-existence copy', async () => {
    stubUnauthenticatedLanding({
      signUp: () =>
        jsonResponse(422, {
          code: 'USER_ALREADY_EXISTS',
          message: 'User already exists',
        }),
    });
    renderApp('/');

    await screen.findByRole('heading', { name: 'Welcome back', level: 1 });
    await userEvent.click(
      screen.getByRole('button', { name: 'Create an account' }),
    );
    await userEvent.type(screen.getByRole('textbox', { name: /name/i }), 'Alex');
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
      await screen.findByText('Couldn’t create this account. Try signing in.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/already exists/i)).not.toBeInTheDocument();
  });

  it('signs in from the unauthenticated landing and refreshes /me', async () => {
    const fetchMock = stubUnauthenticatedLanding({});
    renderApp('/');

    expect(
      await screen.findByRole('heading', { name: 'Welcome back', level: 1 }),
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
      await screen.findByRole('heading', {
        name: 'Welcome to Roomies',
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes('/api/auth/sign-in/email'),
      ),
    ).toBe(true);
  });

  it('shows a useful unverified message after sign-up without blocking the app', async () => {
    const fetchMock = stubUnauthenticatedLanding({
      afterAuth: { emailVerified: false },
      signUp: (init) => {
        const rawBody = init?.body;
        if (typeof rawBody === 'string') {
          const parsed: unknown = JSON.parse(rawBody);
          expect(parsed).toEqual(
            expect.objectContaining({
              callbackURL: `${window.location.origin}/verify-email`,
            }),
          );
        }
        return jsonResponse(200, {
          token: 'session',
          user: { id: 'user-id' },
        });
      },
    });
    renderApp('/');

    await screen.findByRole('heading', { name: 'Welcome back', level: 1 });
    await userEvent.click(
      screen.getByRole('button', { name: 'Create an account' }),
    );
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
      await screen.findByText(/you can use roomies now/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/you must verify before using roomies/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Resend verification email' }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Welcome to Roomies', level: 1 }),
      ).toBeInTheDocument();
    });
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes('/api/auth/sign-up/email'),
      ),
    ).toBe(true);
  });
});
