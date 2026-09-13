import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../platform/api/index.js';
import { renderApp } from '../test/render.js';
import {
  currentUserHomesQueryKey,
  currentUserQueryKey,
  homeContextQueryKey,
} from './home-query-keys.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

type HomeRow = {
  id: string;
  name: string;
  timezone: string;
  role: 'ADMIN' | 'ROOMMATE';
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubRoomiesApis(options: {
  meStatus?: number;
  homes?: readonly HomeRow[];
  homesStatus?: number;
  contexts?: Record<string, { status: number; body: unknown }>;
  delayedHomeId?: string;
}) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    const path = String(url);
    if (path.includes('/api/v1/me/homes')) {
      return Promise.resolve(
        jsonResponse(options.homesStatus ?? 200, options.homes ?? []),
      );
    }
    if (path.endsWith('/api/v1/me')) {
      if ((options.meStatus ?? 200) === 401) {
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
    const homeMatch = /\/api\/v1\/homes\/([0-9a-f-]+)/i.exec(path);
    if (homeMatch?.[1] !== undefined) {
      const homeId = homeMatch[1];
      const override = options.contexts?.[homeId];
      if (override !== undefined) {
        const response = jsonResponse(override.status, override.body);
        if (options.delayedHomeId === homeId) {
          return new Promise<Response>((resolve) => {
            setTimeout(() => {
              resolve(response);
            }, 50);
          });
        }
        return Promise.resolve(response);
      }
      return Promise.resolve(
        jsonResponse(404, {
          error: { code: 'NOT_FOUND', message: 'Not found' },
        }),
      );
    }
    return Promise.resolve(
      jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'Not found' } }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('active Home discovery and shell', () => {
  it('shows a real zero-Homes state and no Owner or Membership wording', async () => {
    stubRoomiesApis({ homes: [] });
    const { queryClient } = renderApp('/');

    expect(
      await screen.findByRole('heading', {
        name: 'You’re not currently in a Home',
        level: 2,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Your Homes', level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create a Home' }),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/owner|membership/i);
    expect(queryClient.getQueryData(currentUserQueryKey)).toEqual({
      id: USER_ID,
    });
    expect(queryClient.getQueryData(currentUserHomesQueryKey)).toEqual([]);
  });

  it('navigates a one-Home User to the authorized Home URL', async () => {
    stubRoomiesApis({
      homes: [
        {
          id: HOME_A,
          name: 'Oak Street',
          timezone: 'UTC',
          role: 'ADMIN',
        },
      ],
      contexts: {
        [HOME_A]: {
          status: 200,
          body: {
            id: HOME_A,
            name: 'Oak Street',
            timezone: 'UTC',
          },
        },
      },
    });
    const { router } = renderApp('/');

    expect(
      await screen.findByRole('heading', { name: 'Oak Street', level: 1 }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/homes/${HOME_A}`);
    expect(
      screen.getByRole('link', { name: 'Your Homes' }),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/owner|membership/i);
  });

  it('lists multiple Homes and opens the selected URL', async () => {
    stubRoomiesApis({
      homes: [
        {
          id: HOME_A,
          name: 'Cedar House',
          timezone: 'UTC',
          role: 'ROOMMATE',
        },
        {
          id: HOME_B,
          name: 'Oak Street',
          timezone: 'UTC',
          role: 'ADMIN',
        },
      ],
      contexts: {
        [HOME_B]: {
          status: 200,
          body: { id: HOME_B, name: 'Oak Street', timezone: 'UTC' },
        },
      },
    });
    const { router } = renderApp('/');

    expect(
      await screen.findByRole('link', { name: /Cedar House/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Your Homes', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText('Roommate')).toBeInTheDocument();
    expect(screen.getByText('Home Admin')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('link', { name: /Oak Street/ }));

    expect(
      await screen.findByRole('heading', { name: 'Oak Street', level: 1 }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/homes/${HOME_B}`);
    expect(screen.queryByText('Cedar House')).not.toBeInTheDocument();
  });

  it('registers /homes/:homeId and loads that Home context', async () => {
    stubRoomiesApis({
      contexts: {
        [HOME_A]: {
          status: 200,
          body: { id: HOME_A, name: 'Oak Street', timezone: 'UTC' },
        },
      },
    });
    const { router, queryClient } = renderApp(`/homes/${HOME_A}`);

    expect(
      await screen.findByRole('heading', { name: 'Oak Street', level: 1 }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/homes/${HOME_A}`);
    expect(queryClient.getQueryData(homeContextQueryKey(HOME_A))).toEqual({
      id: HOME_A,
      name: 'Oak Street',
      timezone: 'UTC',
    });
    expect(homeContextQueryKey(HOME_A)).toContain(HOME_A);
  });

  it('shows a safe unavailable experience for an inaccessible Home', async () => {
    stubRoomiesApis({
      contexts: {
        [HOME_B]: {
          status: 404,
          body: { error: { code: 'NOT_FOUND', message: 'Not found' } },
        },
      },
    });
    renderApp(`/homes/${HOME_B}`);

    expect(
      await screen.findByRole('heading', {
        name: 'This Home isn’t available',
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Private Home')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(
      /owner|membership|forbidden/i,
    );
  });

  it('does not render the previous Home identity while the next URL loads', async () => {
    stubRoomiesApis({
      contexts: {
        [HOME_A]: {
          status: 200,
          body: { id: HOME_A, name: 'Oak Street', timezone: 'UTC' },
        },
        [HOME_B]: {
          status: 200,
          body: { id: HOME_B, name: 'Cedar House', timezone: 'UTC' },
        },
      },
      delayedHomeId: HOME_B,
    });
    const { router } = renderApp(`/homes/${HOME_A}`);

    expect(
      await screen.findByRole('heading', { name: 'Oak Street', level: 1 }),
    ).toBeInTheDocument();

    await router.navigate(`/homes/${HOME_B}`);

    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { name: 'Oak Street', level: 1 }),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByText('Loading this Home')).toBeInTheDocument();

    expect(
      await screen.findByRole('heading', { name: 'Cedar House', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Oak Street')).not.toBeInTheDocument();
  });

  it('clears private Home state when authentication is lost', async () => {
    let meStatus = 200;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const path = String(url);
      if (path.includes('/api/v1/me/homes')) {
        return Promise.resolve(
          jsonResponse(200, [
            {
              id: HOME_A,
              name: 'Oak Street',
              timezone: 'UTC',
              role: 'ADMIN',
            },
          ]),
        );
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
      if (path.includes(`/api/v1/homes/${HOME_A}`)) {
        return Promise.resolve(
          jsonResponse(200, {
            id: HOME_A,
            name: 'Oak Street',
            timezone: 'UTC',
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

    const { queryClient } = renderApp(`/homes/${HOME_A}`);
    expect(
      await screen.findByRole('heading', { name: 'Oak Street', level: 1 }),
    ).toBeInTheDocument();
    expect(queryClient.getQueryData(homeContextQueryKey(HOME_A))).toBeDefined();

    meStatus = 401;
    await queryClient.invalidateQueries({ queryKey: currentUserQueryKey });

    expect(
      await screen.findByText('Sign in to see your Homes.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Oak Street' }),
    ).not.toBeInTheDocument();
    expect(
      queryClient.getQueryData(homeContextQueryKey(HOME_A)),
    ).toBeUndefined();
    expect(queryClient.getQueryData(currentUserHomesQueryKey)).toBeUndefined();
  });
});
