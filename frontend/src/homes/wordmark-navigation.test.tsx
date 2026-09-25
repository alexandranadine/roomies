import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubNotificationsApis } from '../notifications/test-stub.js';
import { listPage, TEST_HOME_B } from '../notifications/test-fixtures.js';
import { stubPulseApis } from '../pulse/test-stub.js';
import { resetApiClientForTests } from '../platform/api/index.js';
import { renderApp } from '../test/render.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubAccountApisWithHomes(
  homes: readonly {
    id: string;
    name: string;
    timezone: string;
    role: 'ADMIN' | 'ROOMMATE';
    hasPhoto: boolean;
  }[] = [],
) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const path = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();

      if (path.endsWith('/api/v1/me') && method === 'GET') {
        return Promise.resolve(jsonResponse(200, { id: USER_ID }));
      }

      if (path.includes('/api/v1/me/homes') && method === 'GET') {
        return Promise.resolve(jsonResponse(200, homes));
      }

      if (path.includes('/api/auth/get-session') && method === 'GET') {
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

      return Promise.resolve(
        jsonResponse(404, {
          error: { code: 'NOT_FOUND', message: 'Not found' },
        }),
      );
    }),
  );
}

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('authenticated Roomies wordmark navigation', () => {
  it('links Account to the preferred Home when one is available', async () => {
    stubAccountApisWithHomes([
      {
        id: HOME_A,
        name: 'Oak Street',
        timezone: 'UTC',
        role: 'ADMIN',
        hasPhoto: false,
      },
    ]);
    renderApp('/account');

    expect(
      await screen.findByRole('heading', { name: 'Account', level: 1 }),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Roomies' })).toHaveAttribute(
        'href',
        `/homes/${HOME_A}`,
      );
    });
  });

  it('links Notifications to the current Home after leaving Home chrome', async () => {
    const user = userEvent.setup();
    stubNotificationsApis({
      list: listPage([]),
    });
    renderApp(`/homes/${HOME_A}`);

    expect(
      await screen.findByRole('heading', { name: 'Oak Street', level: 1 }),
    ).toBeInTheDocument();

    await user.click(
      await screen.findByRole('link', { name: /Notifications/ }),
    );

    expect(
      await screen.findByRole('heading', { name: 'Notifications', level: 1 }),
    ).toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'Roomies' })).toHaveAttribute(
      'href',
      `/homes/${HOME_A}`,
    );
  });

  it('falls back to discovery when no Home can be resolved safely', async () => {
    stubAccountApisWithHomes([
      {
        id: HOME_A,
        name: 'Oak Street',
        timezone: 'UTC',
        role: 'ADMIN',
        hasPhoto: false,
      },
      {
        id: HOME_B,
        name: 'Cedar House',
        timezone: 'UTC',
        role: 'ROOMMATE',
        hasPhoto: false,
      },
    ]);
    renderApp('/account');

    expect(
      await screen.findByRole('heading', { name: 'Account', level: 1 }),
    ).toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'Roomies' })).toHaveAttribute(
      'href',
      '/',
    );
  });

  it('links Account to the cached current Home when multiple Homes exist', async () => {
    const user = userEvent.setup();
    stubPulseApis();
    renderApp(`/homes/${TEST_HOME_B}`);

    expect(
      await screen.findByRole('heading', { name: 'Cedar House', level: 1 }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Account' }));

    expect(
      await screen.findByRole('heading', { name: 'Account', level: 1 }),
    ).toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'Roomies' })).toHaveAttribute(
      'href',
      `/homes/${TEST_HOME_B}`,
    );
  });
});
