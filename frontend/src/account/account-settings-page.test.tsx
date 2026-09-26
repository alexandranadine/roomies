import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  currentUserHomesQueryKey,
  currentUserQueryKey,
  homeContextQueryKey,
} from '../homes/home-query-keys.js';
import { notificationKeys } from '../notifications/notifications-query-keys.js';
import { resetApiClientForTests } from '../platform/api/index.js';
import { renderApp } from '../test/render.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function emptyResponse(status: number) {
  return new Response(null, { status });
}

type DeleteHandler = (init?: RequestInit) => Promise<Response> | Response;

function stubAccountApis(
  options: {
    deleteHandler?: DeleteHandler;
    meAfterDelete?: 'unauthenticated' | 'authenticated';
    session?: {
      name?: string;
      email?: string;
      emailVerified?: boolean;
    };
    sendVerification?: () => Promise<Response> | Response;
    homes?: readonly {
      id: string;
      name: string;
      timezone: string;
      role: 'ADMIN' | 'ROOMMATE';
      hasPhoto: boolean;
    }[];
  } = {},
) {
  let meAuthenticated = true;
  let deleteCalls = 0;
  const sessionUser = {
    id: USER_ID,
    name: options.session?.name ?? 'Alexandra',
    email: options.session?.email ?? 'alex@example.com',
    emailVerified: options.session?.emailVerified ?? true,
  };

  const fetchMock = vi
    .fn()
    .mockImplementation((url: string, init?: RequestInit) => {
      const path = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();

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
        return Promise.resolve(jsonResponse(200, options.homes ?? []));
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
            user: sessionUser,
          }),
        );
      }

      if (path.includes('/api/auth/send-verification-email') && method === 'POST') {
        const result =
          options.sendVerification?.() ?? jsonResponse(200, { status: true });
        return Promise.resolve(result);
      }

      if (path.includes('/api/auth/sign-out') && method === 'POST') {
        meAuthenticated = false;
        return Promise.resolve(jsonResponse(200, { success: true }));
      }

      if (path.endsWith('/api/v1/account') && method === 'DELETE') {
        deleteCalls += 1;
        const result = options.deleteHandler?.(init) ?? emptyResponse(204);
        return Promise.resolve(result).then((response) => {
          if (
            response.status === 204 &&
            options.meAfterDelete !== 'authenticated'
          ) {
            meAuthenticated = false;
          }
          if (response.status === 401) {
            meAuthenticated = false;
          }
          return response;
        });
      }

      if (path.endsWith(`/api/v1/homes/${HOME_ID}`) && method === 'GET') {
        const home = options.homes?.find((entry) => entry.id === HOME_ID);
        if (home === undefined) {
          return Promise.resolve(
            jsonResponse(404, {
              error: { code: 'NOT_FOUND', message: 'Not found' },
            }),
          );
        }
        return Promise.resolve(
          jsonResponse(200, {
            id: home.id,
            name: home.name,
            timezone: home.timezone,
            hasPhoto: home.hasPhoto,
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
  return {
    fetchMock,
    getDeleteCalls: () => deleteCalls,
  };
}

async function openDeleteDialog() {
  renderApp('/account');
  await screen.findByRole('heading', { name: 'Account', level: 1 });
  await userEvent.click(screen.getByRole('button', { name: 'Delete account' }));
  const dialog = await screen.findByRole('dialog');
  expect(
    within(dialog).getByRole('heading', { name: 'Delete account' }),
  ).toBeInTheDocument();
  return dialog;
}

function confirmationField(dialog: HTMLElement) {
  return within(dialog).getByLabelText(/type delete to confirm/i);
}

function submitButton(dialog: HTMLElement) {
  return within(dialog).getByRole('button', { name: 'Delete my account' });
}

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('Account settings deletion', () => {
  it('shows Delete account on Account settings', async () => {
    stubAccountApis();
    renderApp('/account');

    expect(
      await screen.findByRole('heading', { name: 'Account', level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Delete account', level: 2 }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Delete account' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Account' })).toHaveAttribute(
      'href',
      '/account',
    );
  });

  it('renders display name, email, and verified status from the session', async () => {
    stubAccountApis();
    renderApp('/account');

    expect(
      await screen.findByRole('heading', { name: 'Alexandra', level: 2 }),
    ).toBeInTheDocument();
    expect(screen.getByText('alex@example.com')).toBeInTheDocument();
    expect(screen.getByText('Verified')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Alexandra' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/name/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('does not invent a display name when the session has none', async () => {
    stubAccountApis({
      session: { name: '', email: 'alex@example.com', emailVerified: true },
    });
    renderApp('/account');

    expect(
      await screen.findByRole('heading', {
        name: 'alex@example.com',
        level: 2,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Alexandra', level: 2 }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Verified')).toBeInTheDocument();
  });

  it('wraps a long email without exposing the user id', async () => {
    const longEmail =
      'alexandra.nadine.lewis+roomies-household@example.com';
    stubAccountApis({
      session: {
        name: 'Alexandra Nadine Lewis',
        email: longEmail,
        emailVerified: true,
      },
    });
    renderApp('/account');

    expect(
      await screen.findByRole('heading', {
        name: 'Alexandra Nadine Lewis',
        level: 2,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(longEmail)).toBeInTheDocument();
    expect(screen.queryByText(USER_ID)).not.toBeInTheDocument();
  });

  it('shows unverified status and resends without implying Roomies is blocked', async () => {
    const user = userEvent.setup();
    let sendCalls = 0;
    stubAccountApis({
      session: { emailVerified: false },
      sendVerification: () => {
        sendCalls += 1;
        return jsonResponse(200, { status: true });
      },
    });
    renderApp('/account');

    expect(await screen.findByText('Email not verified')).toBeInTheDocument();
    expect(screen.queryByText('Verified')).not.toBeInTheDocument();
    expect(
      screen.queryByText(/required to use roomies/i),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole('button', {
        name: 'Resend verification email to alex@example.com',
      }),
    );

    await waitFor(() => {
      expect(sendCalls).toBe(1);
    });
    expect(await screen.findByText(/check your email/i)).toBeInTheDocument();
  });

  it('shows a generic resend error without backend codes', async () => {
    const user = userEvent.setup();
    stubAccountApis({
      session: { emailVerified: false },
      sendVerification: () =>
        jsonResponse(500, {
          code: 'INTERNAL_ERROR',
          message: 'smtp host leaked',
        }),
    });
    renderApp('/account');

    await user.click(
      await screen.findByRole('button', {
        name: 'Resend verification email to alex@example.com',
      }),
    );

    expect(
      await screen.findByText(/couldn’t send a verification email/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/smtp host leaked/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/INTERNAL_ERROR/i)).not.toBeInTheDocument();
  });

  it('signs out and returns to the sign-in landing', async () => {
    stubAccountApis();
    renderApp('/account');
    await screen.findByRole('heading', { name: 'Account', level: 1 });
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(
      await screen.findByRole('heading', { name: 'Welcome back', level: 1 }),
    ).toBeInTheDocument();
  });

  it('opens the confirmation dialog from Delete account', async () => {
    stubAccountApis();
    const dialog = await openDeleteDialog();

    expect(
      within(dialog).getByText(/you’ll be signed out/i),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/maintenance you personally created/i),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/home admin before deletion can proceed/i),
    ).toBeInTheDocument();
  });

  it('keeps the final action disabled until exact DELETE is typed', async () => {
    stubAccountApis();
    const dialog = await openDeleteDialog();
    const submit = submitButton(dialog);
    const field = confirmationField(dialog);

    expect(submit).toBeDisabled();

    await userEvent.type(field, 'delete');
    expect(submit).toBeDisabled();

    await userEvent.clear(field);
    await userEvent.type(field, 'Delete');
    expect(submit).toBeDisabled();

    await userEvent.clear(field);
    field.focus();
    await userEvent.paste(' DELETE');
    expect(field).toHaveValue(' DELETE');
    expect(submit).toBeDisabled();

    await userEvent.clear(field);
    field.focus();
    await userEvent.paste('DELETE ');
    expect(field).toHaveValue('DELETE ');
    expect(submit).toBeDisabled();

    await userEvent.clear(field);
    await userEvent.type(field, 'DELETE!');
    expect(submit).toBeDisabled();

    await userEvent.clear(field);
    await userEvent.type(field, 'DELETE');
    expect(submit).toBeEnabled();
  });

  it('sends exact DELETE /api/v1/account with confirmation body', async () => {
    const { fetchMock } = stubAccountApis();
    const dialog = await openDeleteDialog();

    await userEvent.type(confirmationField(dialog), 'DELETE');
    await userEvent.click(submitButton(dialog));

    await waitFor(() => {
      const deleteCall = fetchMock.mock.calls.find((call) => {
        const url = String(call[0]);
        const init = call[1] as RequestInit | undefined;
        return (
          url.includes('/api/v1/account') &&
          (init?.method ?? 'GET').toUpperCase() === 'DELETE'
        );
      });
      expect(deleteCall).toBeDefined();
      const deleteInit = deleteCall?.[1] as RequestInit | undefined;
      expect(typeof deleteInit?.body).toBe('string');
      expect(JSON.parse(deleteInit?.body as string)).toEqual({
        confirmation: 'DELETE',
      });
    });
  });

  it('prevents duplicate submit while pending', async () => {
    let resolveDelete: ((value: Response) => void) | undefined;
    const { getDeleteCalls } = stubAccountApis({
      deleteHandler: () =>
        new Promise<Response>((resolve) => {
          resolveDelete = resolve;
        }),
    });

    const dialog = await openDeleteDialog();
    await userEvent.type(confirmationField(dialog), 'DELETE');
    const submit = submitButton(dialog);

    await userEvent.click(submit);
    await waitFor(() => {
      expect(submit).toBeDisabled();
      expect(confirmationField(dialog)).toBeDisabled();
    });

    await userEvent.click(submit);
    expect(getDeleteCalls()).toBe(1);

    resolveDelete?.(emptyResponse(204));
    expect(
      await screen.findByText(/your roomies account has been deleted/i),
    ).toBeInTheDocument();
  });

  it('clears private cache and leaves no protected Home content after 204', async () => {
    const { fetchMock } = stubAccountApis({
      homes: [
        {
          id: HOME_ID,
          name: 'Oak Street',
          timezone: 'UTC',
          role: 'ADMIN',
          hasPhoto: false,
        },
      ],
    });
    const { queryClient } = renderApp('/account');

    await screen.findByRole('heading', { name: 'Account', level: 1 });
    await waitFor(() => {
      expect(screen.getByRole('navigation', { name: 'Home' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Delete account' })).toBeEnabled();
    });

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

    await userEvent.click(
      screen.getByRole('button', { name: 'Delete account' }),
    );
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(confirmationField(dialog), 'DELETE');
    await userEvent.click(submitButton(dialog));

    expect(
      await screen.findByText(/your roomies account has been deleted/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('Oak Street')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Account', level: 1 }),
    ).not.toBeInTheDocument();
    expect(queryClient.getQueryData(currentUserHomesQueryKey)).toBeUndefined();
    expect(
      queryClient.getQueryData(homeContextQueryKey(HOME_ID)),
    ).toBeUndefined();
    expect(queryClient.getQueryData(notificationKeys.list({}))).toBeUndefined();
    expect(queryClient.getQueryData(currentUserQueryKey)).toBeUndefined();
    expect(
      fetchMock.mock.calls.some((call) => {
        const init = call[1] as RequestInit | undefined;
        return (
          String(call[0]).includes('/api/v1/account') &&
          (init?.method ?? '').toUpperCase() === 'DELETE'
        );
      }),
    ).toBe(true);
  });

  it('shows LAST_ADMIN_REQUIRED guidance and keeps the user signed in', async () => {
    const { getDeleteCalls } = stubAccountApis({
      deleteHandler: () =>
        jsonResponse(409, {
          error: {
            code: 'LAST_ADMIN_REQUIRED',
            message: 'Last admin required',
          },
        }),
    });

    const { queryClient } = renderApp('/account');
    await screen.findByRole('heading', { name: 'Account', level: 1 });
    queryClient.setQueryData(currentUserQueryKey, { id: USER_ID });

    await userEvent.click(
      screen.getByRole('button', { name: 'Delete account' }),
    );
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(confirmationField(dialog), 'DELETE');
    await userEvent.click(submitButton(dialog));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /only home admin/i,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(
      screen.queryByText(/your roomies account has been deleted/i),
    ).not.toBeInTheDocument();
    expect(queryClient.getQueryData(currentUserQueryKey)).toEqual({
      id: USER_ID,
    });
    expect(getDeleteCalls()).toBe(1);
  });

  it('routes 401 into the existing auth-loss flow without claiming success', async () => {
    stubAccountApis({
      homes: [
        {
          id: HOME_ID,
          name: 'Oak Street',
          timezone: 'UTC',
          role: 'ADMIN',
          hasPhoto: false,
        },
      ],
      deleteHandler: () =>
        jsonResponse(401, {
          error: {
            code: 'UNAUTHENTICATED',
            message: 'Authentication required',
          },
        }),
    });

    const { queryClient } = renderApp('/account');
    await screen.findByRole('heading', { name: 'Account', level: 1 });
    await waitFor(() => {
      expect(screen.getByRole('navigation', { name: 'Home' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Delete account' })).toBeEnabled();
    });

    await userEvent.click(
      screen.getByRole('button', { name: 'Delete account' }),
    );
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(confirmationField(dialog), 'DELETE');
    await userEvent.click(submitButton(dialog));

    expect(
      await screen.findByRole('heading', { name: 'Welcome back', level: 1 }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/sign in again, then try deleting your account/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/your roomies account has been deleted/i),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(queryClient.getQueryData(currentUserHomesQueryKey)).toBeUndefined();
    });
  });

  it('does not claim success for 400, 403, or 5xx', async () => {
    for (const failure of [
      {
        status: 400,
        body: {
          error: { code: 'INVALID_REQUEST', message: 'Invalid request' },
        },
      },
      {
        status: 403,
        body: { error: { code: 'FORBIDDEN', message: 'Forbidden' } },
      },
      {
        status: 500,
        body: {
          error: { code: 'INTERNAL', message: 'Internal server error' },
        },
      },
    ] as const) {
      resetApiClientForTests();
      vi.unstubAllGlobals();
      stubAccountApis({
        deleteHandler: () => jsonResponse(failure.status, failure.body),
      });

      const { queryClient, unmount } = renderApp('/account');
      await screen.findByRole('heading', { name: 'Account', level: 1 });
      queryClient.setQueryData(currentUserQueryKey, { id: USER_ID });

      await userEvent.click(
        screen.getByRole('button', { name: 'Delete account' }),
      );
      const dialog = await screen.findByRole('dialog');
      await userEvent.type(confirmationField(dialog), 'DELETE');
      await userEvent.click(submitButton(dialog));

      expect(await screen.findByRole('alert')).toBeInTheDocument();
      expect(
        screen.queryByText(/your roomies account has been deleted/i),
      ).not.toBeInTheDocument();
      expect(queryClient.getQueryData(currentUserQueryKey)).toEqual({
        id: USER_ID,
      });
      unmount();
    }
  });

  it('preserves authenticated state on network failure', async () => {
    stubAccountApis({
      deleteHandler: () => {
        throw new TypeError('Failed to fetch');
      },
    });

    const { queryClient } = renderApp('/account');
    await screen.findByRole('heading', { name: 'Account', level: 1 });
    queryClient.setQueryData(currentUserQueryKey, { id: USER_ID });

    await userEvent.click(
      screen.getByRole('button', { name: 'Delete account' }),
    );
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(confirmationField(dialog), 'DELETE');
    await userEvent.click(submitButton(dialog));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /couldn’t delete your account/i,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(queryClient.getQueryData(currentUserQueryKey)).toEqual({
      id: USER_ID,
    });
    expect(
      screen.queryByText(/your roomies account has been deleted/i),
    ).not.toBeInTheDocument();
  });

  it('supports keyboard dismiss with focus return and announces errors', async () => {
    stubAccountApis({
      deleteHandler: () =>
        jsonResponse(500, {
          error: { code: 'INTERNAL', message: 'Internal server error' },
        }),
    });

    renderApp('/account');
    await screen.findByRole('heading', { name: 'Account', level: 1 });
    const trigger = screen.getByRole('button', { name: 'Delete account' });
    await userEvent.click(trigger);

    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });

    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();

    await userEvent.click(trigger);
    const reopened = await screen.findByRole('dialog');
    await userEvent.type(confirmationField(reopened), 'DELETE');
    await userEvent.click(submitButton(reopened));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn’t delete your account/i);
  });

  it('does not persist the confirmation phrase', async () => {
    stubAccountApis();
    const dialog = await openDeleteDialog();
    await userEvent.type(confirmationField(dialog), 'DELETE');

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(window.location.href).not.toMatch(/DELETE/);

    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Cancel' }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByRole('button', { name: 'Delete account' }),
    );
    const reopened = await screen.findByRole('dialog');
    expect(confirmationField(reopened)).toHaveValue('');
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});
