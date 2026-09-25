import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubPulseApis } from '../pulse/test-stub.js';
import { TEST_HOME_A } from '../pulse/test-fixtures.js';

const SINGLE_HOME = [
  {
    id: TEST_HOME_A,
    name: 'Oak Street',
    timezone: 'UTC',
    hasPhoto: false,
    role: 'ADMIN' as const,
  },
];
import { resetApiClientForTests } from '../platform/api/index.js';
import { renderApp } from '../test/render.js';

function stubWideViewport() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches:
        query === '(min-width: 768px)' || query === '(min-width: 1024px)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Account shell navigation', () => {
  it('renders shared authenticated desktop nav with correct destinations', async () => {
    stubWideViewport();
    stubPulseApis({ homes: SINGLE_HOME });
    renderApp('/account');

    expect(
      await screen.findByRole('heading', { name: 'Account', level: 1 }),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute(
        'href',
        `/homes/${TEST_HOME_A}`,
      );
    });

    expect(screen.getByRole('link', { name: 'Tasks' })).toHaveAttribute(
      'href',
      `/homes/${TEST_HOME_A}/tasks`,
    );
    expect(screen.getByRole('link', { name: 'Roommates' })).toHaveAttribute(
      'href',
      `/homes/${TEST_HOME_A}/roommates`,
    );
    expect(screen.getByRole('link', { name: 'Account' })).toHaveAttribute(
      'href',
      '/account',
    );
    expect(screen.getByRole('link', { name: /Notifications/ })).toHaveAttribute(
      'href',
      '/notifications',
    );
    expect(
      screen.getByRole('button', { name: 'Add to this Home' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Roomies' })).toHaveAttribute(
      'href',
      `/homes/${TEST_HOME_A}`,
    );
    expect(screen.getByTestId('account-page')).toBeInTheDocument();
  });

  it('marks Profile/Account as the active desktop destination', async () => {
    stubWideViewport();
    stubPulseApis({ homes: SINGLE_HOME });
    renderApp('/account');

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
    });

    const accountNav = screen.getByRole('link', { name: 'Account' });
    expect(accountNav).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('uses bottom nav on mobile with Profile active and Add control', async () => {
    stubPulseApis({ homes: SINGLE_HOME });
    renderApp('/account');

    expect(
      await screen.findByRole('heading', { name: 'Account', level: 1 }),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByRole('navigation', { name: 'Home' })).toBeInTheDocument();
    });

    expect(screen.getByRole('link', { name: 'Account' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute(
      'href',
      `/homes/${TEST_HOME_A}`,
    );
    expect(
      screen.getByRole('button', { name: 'Add to this Home' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('account-page')).toBeInTheDocument();
  });
});
