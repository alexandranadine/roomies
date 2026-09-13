import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../platform/api/index.js';
import { renderApp } from '../test/render.js';
import { HOME_NAME_MAX_LENGTH } from './supported-timezones.js';
import {
  currentUserHomesQueryKey,
  currentUserQueryKey,
} from './home-query-keys.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBERSHIP_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubDiscoveryApis(options: {
  createStatus?: number;
  createDelayMs?: number;
  createBody?: unknown;
  homeContext?: { status: number; body: unknown };
}) {
  let createCalls = 0;
  const fetchMock = vi
    .fn()
    .mockImplementation((url: string, init?: RequestInit) => {
      const path = String(url);
      if (
        path.includes('/api/v1/me/homes') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return Promise.resolve(jsonResponse(200, []));
      }
      if (path.endsWith('/api/v1/me')) {
        return Promise.resolve(jsonResponse(200, { id: USER_ID }));
      }
      if (path.endsWith('/api/v1/homes') && init?.method === 'POST') {
        createCalls += 1;
        const response = jsonResponse(
          options.createStatus ?? 201,
          options.createBody ?? {
            home: {
              id: HOME_ID,
              name: 'Oak Street',
              timezone: 'America/New_York',
            },
            membership: { id: MEMBERSHIP_ID, role: 'ADMIN' },
          },
        );
        if (options.createDelayMs !== undefined) {
          return new Promise<Response>((resolve) => {
            setTimeout(() => {
              resolve(response);
            }, options.createDelayMs);
          });
        }
        return Promise.resolve(response);
      }
      if (path.includes(`/api/v1/homes/${HOME_ID}`)) {
        return Promise.resolve(
          jsonResponse(
            options.homeContext?.status ?? 200,
            options.homeContext?.body ?? {
              id: HOME_ID,
              name: 'Oak Street',
              timezone: 'America/New_York',
            },
          ),
        );
      }
      return Promise.resolve(
        jsonResponse(404, {
          error: { code: 'NOT_FOUND', message: 'Not found' },
        }),
      );
    });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, getCreateCalls: () => createCalls };
}

async function openCreateHomeForm() {
  renderApp('/');
  await userEvent.click(
    await screen.findByRole('button', { name: 'Create a Home' }),
  );
  expect(
    screen.getByRole('heading', { name: 'Create a Home', level: 2 }),
  ).toBeInTheDocument();
}

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('Create Home UX', () => {
  it('exposes Create Home from the zero-Homes discovery state', async () => {
    stubDiscoveryApis({});
    renderApp('/');

    expect(
      await screen.findByRole('heading', {
        name: 'You’re not currently in a Home',
        level: 2,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create a Home' }),
    ).toBeInTheDocument();
  });

  it('renders Home name and timezone fields in the form', async () => {
    stubDiscoveryApis({});
    await openCreateHomeForm();

    expect(screen.getByLabelText(/home name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/timezone/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create Home' }),
    ).toBeInTheDocument();
  });

  it('prefills browser timezone when supported', async () => {
    const browserTimeZone = 'America/Los_Angeles';
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      locale: 'en-US',
      calendar: 'gregory',
      numberingSystem: 'latn',
      timeZone: browserTimeZone,
      hour12: true,
    });

    stubDiscoveryApis({});
    await openCreateHomeForm();

    expect(screen.getByLabelText(/timezone/i)).toHaveValue(browserTimeZone);
  });

  it('lets the User change timezone before submit', async () => {
    const { fetchMock } = stubDiscoveryApis({});
    await openCreateHomeForm();

    const timezone = screen.getByLabelText(/timezone/i);
    await userEvent.clear(timezone);
    await userEvent.type(timezone, 'America/Chicago');
    await userEvent.type(screen.getByLabelText(/home name/i), 'Lakeview');
    await userEvent.click(screen.getByRole('button', { name: 'Create Home' }));

    await screen.findByRole('heading', { name: 'Oak Street', level: 1 });

    const postCall = fetchMock.mock.calls.find((call) => {
      const [url, init] = call as [string, RequestInit | undefined];
      return String(url).endsWith('/api/v1/homes') && init?.method === 'POST';
    }) as [string, RequestInit] | undefined;
    expect(postCall).toBeDefined();
    if (postCall === undefined) {
      throw new Error('missing create Home request');
    }
    expect(JSON.parse(postCall[1].body as string)).toEqual({
      name: 'Lakeview',
      timezone: 'America/Chicago',
    });
  });

  it('rejects an empty Home name on the client', async () => {
    stubDiscoveryApis({});
    await openCreateHomeForm();

    await userEvent.click(screen.getByRole('button', { name: 'Create Home' }));

    expect(await screen.findByText('Enter a Home name.')).toBeInTheDocument();
  });

  it('rejects a Home name longer than 80 characters', async () => {
    stubDiscoveryApis({});
    await openCreateHomeForm();

    await userEvent.type(
      screen.getByLabelText(/home name/i),
      'a'.repeat(HOME_NAME_MAX_LENGTH + 1),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Create Home' }));

    expect(
      await screen.findByText(
        `Home name must be ${HOME_NAME_MAX_LENGTH} characters or fewer.`,
      ),
    ).toBeInTheDocument();
  });

  it('rejects an empty or unsupported timezone on the client', async () => {
    stubDiscoveryApis({});
    await openCreateHomeForm();

    await userEvent.type(screen.getByLabelText(/home name/i), 'Oak Street');
    await userEvent.clear(screen.getByLabelText(/timezone/i));
    await userEvent.click(screen.getByRole('button', { name: 'Create Home' }));
    expect(await screen.findByText('Select a timezone.')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/timezone/i), 'Not/A/Zone');
    await userEvent.click(screen.getByRole('button', { name: 'Create Home' }));
    expect(
      await screen.findByText('Select a valid timezone.'),
    ).toBeInTheDocument();
  });

  it('POSTs only name and timezone without extra fields', async () => {
    const { fetchMock } = stubDiscoveryApis({});
    await openCreateHomeForm();

    await userEvent.type(screen.getByLabelText(/home name/i), 'Oak Street');
    await userEvent.clear(screen.getByLabelText(/timezone/i));
    await userEvent.type(screen.getByLabelText(/timezone/i), 'UTC');
    await userEvent.click(screen.getByRole('button', { name: 'Create Home' }));

    await screen.findByRole('heading', { name: 'Oak Street', level: 1 });

    const postCall = fetchMock.mock.calls.find((call) => {
      const [url, init] = call as [string, RequestInit | undefined];
      return String(url).endsWith('/api/v1/homes') && init?.method === 'POST';
    }) as [string, RequestInit] | undefined;
    expect(postCall).toBeDefined();
    if (postCall === undefined) {
      throw new Error('missing create Home request');
    }
    const body = JSON.parse(postCall[1].body as string) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({
      name: 'Oak Street',
      timezone: 'UTC',
    });
    expect(Object.keys(body).sort()).toEqual(['name', 'timezone']);
  });

  it('disables submit while the create request is pending', async () => {
    stubDiscoveryApis({ createDelayMs: 100 });
    await openCreateHomeForm();

    await userEvent.type(screen.getByLabelText(/home name/i), 'Oak Street');
    await userEvent.clear(screen.getByLabelText(/timezone/i));
    await userEvent.type(screen.getByLabelText(/timezone/i), 'UTC');

    const submit = screen.getByRole('button', { name: 'Create Home' });
    await userEvent.click(submit);

    await waitFor(() => {
      expect(submit).toBeDisabled();
      expect(submit).toHaveAttribute('aria-busy', 'true');
    });
  });

  it('does not send duplicate create requests from rapid clicks', async () => {
    const { getCreateCalls } = stubDiscoveryApis({ createDelayMs: 100 });
    await openCreateHomeForm();

    await userEvent.type(screen.getByLabelText(/home name/i), 'Oak Street');
    await userEvent.clear(screen.getByLabelText(/timezone/i));
    await userEvent.type(screen.getByLabelText(/timezone/i), 'UTC');

    const submit = screen.getByRole('button', { name: 'Create Home' });
    await userEvent.dblClick(submit);

    await screen.findByRole('heading', { name: 'Oak Street', level: 1 });
    expect(getCreateCalls()).toBe(1);
  });

  it('routes create mutation 401 into the auth-loss flow', async () => {
    let meStatus = 200;
    let createCalls = 0;
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string, init?: RequestInit) => {
        const path = String(url);
        if (
          path.includes('/api/v1/me/homes') &&
          (init?.method ?? 'GET') === 'GET'
        ) {
          return Promise.resolve(jsonResponse(200, []));
        }
        if (path.endsWith('/api/v1/me')) {
          if (meStatus === 401) {
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
        if (path.endsWith('/api/v1/homes') && init?.method === 'POST') {
          createCalls += 1;
          meStatus = 401;
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
          jsonResponse(404, {
            error: { code: 'NOT_FOUND', message: 'Not found' },
          }),
        );
      });
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient } = renderApp('/');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Create a Home' }),
    );
    await userEvent.type(screen.getByLabelText(/home name/i), 'Oak Street');
    await userEvent.clear(screen.getByLabelText(/timezone/i));
    await userEvent.type(screen.getByLabelText(/timezone/i), 'UTC');
    await userEvent.click(screen.getByRole('button', { name: 'Create Home' }));

    expect(
      await screen.findByText('Sign in to see your Homes.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Create a Home', level: 2 }),
    ).not.toBeInTheDocument();
    expect(createCalls).toBe(1);
    expect(queryClient.getQueryData(currentUserHomesQueryKey)).toBeUndefined();
    expect(queryClient.getQueryState(currentUserQueryKey)?.error).toMatchObject(
      { status: 401 },
    );
  });

  it('preserves entered values and shows a safe error on server failure', async () => {
    stubDiscoveryApis({
      createStatus: 400,
      createBody: {
        error: { code: 'INVALID_REQUEST', message: 'Invalid Home name' },
      },
    });
    await openCreateHomeForm();

    await userEvent.type(screen.getByLabelText(/home name/i), 'Oak Street');
    await userEvent.clear(screen.getByLabelText(/timezone/i));
    await userEvent.type(screen.getByLabelText(/timezone/i), 'UTC');
    await userEvent.click(screen.getByRole('button', { name: 'Create Home' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /couldn’t create this home/i,
    );
    expect(screen.getByLabelText(/home name/i)).toHaveValue('Oak Street');
    expect(screen.getByLabelText(/timezone/i)).toHaveValue('UTC');
    expect(screen.getByRole('alert')).not.toHaveTextContent(
      /invalid home name/i,
    );
  });

  it('invalidates active Home discovery and navigates on success', async () => {
    const { fetchMock } = stubDiscoveryApis({});
    const { queryClient, router } = renderApp('/');

    await userEvent.click(
      await screen.findByRole('button', { name: 'Create a Home' }),
    );
    await userEvent.type(screen.getByLabelText(/home name/i), 'Oak Street');
    await userEvent.clear(screen.getByLabelText(/timezone/i));
    await userEvent.type(screen.getByLabelText(/timezone/i), 'UTC');
    await userEvent.click(screen.getByRole('button', { name: 'Create Home' }));

    expect(
      await screen.findByRole('heading', { name: 'Oak Street', level: 1 }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/homes/${HOME_ID}`);

    await waitFor(() => {
      const homesRequests = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/api/v1/me/homes'),
      );
      expect(homesRequests.length).toBeGreaterThan(1);
    });
    expect(queryClient.getQueryData(currentUserHomesQueryKey)).toBeDefined();
  });

  it('does not introduce currentHomeId or localStorage Home authority', async () => {
    stubDiscoveryApis({});
    await openCreateHomeForm();

    await userEvent.type(screen.getByLabelText(/home name/i), 'Oak Street');
    await userEvent.clear(screen.getByLabelText(/timezone/i));
    await userEvent.type(screen.getByLabelText(/timezone/i), 'UTC');
    await userEvent.click(screen.getByRole('button', { name: 'Create Home' }));

    await screen.findByRole('heading', { name: 'Oak Street', level: 1 });
    expect(JSON.stringify(localStorage)).not.toMatch(/currenthomeid|homeid/i);
    expect(JSON.stringify(localStorage)).not.toMatch(/owner|membership/i);
  });

  it('uses accessible labels and avoids Owner or Membership copy', async () => {
    stubDiscoveryApis({});
    await openCreateHomeForm();

    expect(screen.getByLabelText(/home name/i)).toHaveAccessibleName();
    expect(screen.getByLabelText(/timezone/i)).toHaveAccessibleName();
    expect(document.body.textContent).not.toMatch(/owner|membership/i);
  });
});
