import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  currentUserHomesQueryKey,
  currentUserQueryKey,
  homeContextQueryKey,
} from '../homes/home-query-keys.js';
import { invitationAuthSessionQueryKey } from '../invitations/auth-session-api.js';
import { notificationKeys } from '../notifications/notifications-query-keys.js';
import { resetApiClientForTests } from '../platform/api/index.js';
import { renderApp, renderWithProviders } from '../test/render.js';
import { SignOutButton } from './sign-out-button.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type SignOutStubOptions = {
  signOutHandler?: () => Promise<Response> | Response;
  blockAuthRefetchesAfterSignOut?: boolean;
};

function stubSignOutApis(options: SignOutStubOptions = {}) {
  let meAuthenticated = true;
  let authRefetchesBlocked = false;

  const fetchMock = vi
    .fn()
    .mockImplementation((url: string, init?: RequestInit) => {
      const path = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();

      if (path.includes('/api/auth/sign-out') && method === 'POST') {
        if (options.blockAuthRefetchesAfterSignOut) {
          authRefetchesBlocked = true;
        }
        const result =
          options.signOutHandler?.() ??
          Promise.resolve(jsonResponse(200, { success: true }));
        return Promise.resolve(result).then((response) => {
          if (response.ok) {
            meAuthenticated = false;
          }
          return response;
        });
      }

      if (
        authRefetchesBlocked &&
        (path.endsWith('/api/v1/me') || path.includes('/api/auth/get-session'))
      ) {
        return new Promise<Response>(() => {});
      }

      if (path.endsWith('/api/v1/me/homes') && method === 'GET') {
        if (!meAuthenticated) {
          return Promise.resolve(
            jsonResponse(401, {
              error: {
                code: 'UNAUTHENTICATED',
                message: 'Authentication required',
              },
            }),
          );
        }
        return Promise.resolve(jsonResponse(200, []));
      }

      if (path.endsWith('/api/v1/me') && method === 'GET') {
        if (!meAuthenticated) {
          return Promise.resolve(
            jsonResponse(401, {
              error: {
                code: 'UNAUTHENTICATED',
                message: 'Authentication required',
              },
            }),
          );
        }
        return Promise.resolve(jsonResponse(200, { id: USER_ID }));
      }

      if (path.includes('/api/auth/get-session') && method === 'GET') {
        if (!meAuthenticated) {
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
              id: USER_ID,
              name: 'Alexandra',
              email: 'alex@example.com',
              emailVerified: true,
            },
          }),
        );
      }

      if (path.endsWith('/api/v1/notifications') && method === 'GET') {
        return Promise.resolve(
          jsonResponse(200, { items: [], hasMore: false, nextCursor: null }),
        );
      }

      return Promise.resolve(
        jsonResponse(404, {
          error: { code: 'NOT_FOUND', message: 'Not found' },
        }),
      );
    });

  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock };
}

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('SignOutButton', () => {
  it('clears private cache, removes auth queries, and navigates on success', async () => {
    stubSignOutApis();
    const { queryClient, router } = renderApp('/account');

    await screen.findByRole('heading', { name: 'Account', level: 1 });
    queryClient.setQueryData(homeContextQueryKey(HOME_ID), {
      id: HOME_ID,
      name: 'Oak Street',
      timezone: 'UTC',
      hasPhoto: false,
    });
    queryClient.setQueryData(notificationKeys.list({}), {
      pages: [{ items: [], hasMore: false, nextCursor: null }],
      pageParams: [undefined],
    });

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/');
    });
    expect(
      await screen.findByRole('heading', { name: 'Welcome back', level: 1 }),
    ).toBeInTheDocument();
    expect(queryClient.getQueryData(currentUserHomesQueryKey)).toBeUndefined();
    expect(
      queryClient.getQueryData(homeContextQueryKey(HOME_ID)),
    ).toBeUndefined();
    expect(queryClient.getQueryData(notificationKeys.list({}))).toBeUndefined();
    expect(queryClient.getQueryData(currentUserQueryKey)).toBeUndefined();
    expect(
      queryClient.getQueryData(invitationAuthSessionQueryKey),
    ).toBeUndefined();
    expect(
      screen.queryByRole('heading', { name: 'Account', level: 1 }),
    ).not.toBeInTheDocument();
  });

  it('navigates without waiting for blocked auth refetches', async () => {
    stubSignOutApis({ blockAuthRefetchesAfterSignOut: true });
    const { router } = renderApp('/account');
    await screen.findByRole('heading', { name: 'Account', level: 1 });

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/');
    });
  });

  it('ends pending when the POST completes, not when auth refetches settle', async () => {
    let resolveSignOut: ((value: Response) => void) | undefined;
    stubSignOutApis({
      blockAuthRefetchesAfterSignOut: true,
      signOutHandler: () =>
        new Promise<Response>((resolve) => {
          resolveSignOut = resolve;
        }),
    });

    const { queryClient } = renderWithProviders(
      <MemoryRouter>
        <SignOutButton navigateHome={false} />
      </MemoryRouter>,
    );
    queryClient.setQueryData(currentUserQueryKey, { id: USER_ID });
    queryClient.setQueryData(invitationAuthSessionQueryKey, {
      user: {
        id: USER_ID,
        email: 'alex@example.com',
        emailVerified: true,
      },
    });

    const signOutButton = screen.getByRole('button', { name: 'Sign out' });
    await userEvent.click(signOutButton);
    await waitFor(() => {
      expect(signOutButton).toHaveAttribute('aria-busy', 'true');
    });

    resolveSignOut?.(jsonResponse(200, { success: true }));

    await waitFor(() => {
      expect(signOutButton).not.toHaveAttribute('aria-busy', 'true');
    });
    expect(queryClient.getQueryData(currentUserQueryKey)).toBeUndefined();
    expect(
      queryClient.getQueryData(invitationAuthSessionQueryKey),
    ).toBeUndefined();
  });

  it('preserves auth state and does not navigate when sign-out fails', async () => {
    stubSignOutApis({
      signOutHandler: () =>
        jsonResponse(500, {
          error: { code: 'INTERNAL', message: 'Internal server error' },
        }),
    });

    const { queryClient, router } = renderApp('/account');
    await screen.findByRole('heading', { name: 'Account', level: 1 });
    queryClient.setQueryData(currentUserQueryKey, { id: USER_ID });
    queryClient.setQueryData(invitationAuthSessionQueryKey, {
      user: {
        id: USER_ID,
        email: 'alex@example.com',
        emailVerified: true,
      },
    });

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /couldn’t sign out/i,
    );
    expect(router.state.location.pathname).toBe('/account');
    expect(queryClient.getQueryData(currentUserQueryKey)).toEqual({
      id: USER_ID,
    });
    expect(queryClient.getQueryData(invitationAuthSessionQueryKey)).toEqual({
      user: {
        id: USER_ID,
        email: 'alex@example.com',
        emailVerified: true,
      },
    });
    expect(
      screen.getByRole('heading', { name: 'Account', level: 1 }),
    ).toBeInTheDocument();
  });

  it('does not remount authenticated account chrome after successful sign-out', async () => {
    stubSignOutApis();
    renderApp('/account');

    await screen.findByRole('heading', { name: 'Account', level: 1 });
    expect(screen.getByRole('navigation', { name: 'Global' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Account' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(
      await screen.findByRole('heading', { name: 'Welcome back', level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('navigation', { name: 'Global' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Account', level: 1 }),
    ).not.toBeInTheDocument();
  });
});
