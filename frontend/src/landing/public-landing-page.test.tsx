import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SIGN_IN_HREF, SIGN_UP_HREF } from '../auth/auth-entry.js';
import { resetApiClientForTests } from '../platform/api/index.js';
import { renderApp } from '../test/render.js';
import {
  LANDING_ALPHA_BODY,
  LANDING_ALPHA_TITLE,
  LANDING_COMING_HEADING,
  LANDING_COMING_ITEMS,
  LANDING_CREATE_ACCOUNT,
  LANDING_FEATURES,
  LANDING_FEATURES_HEADING,
  LANDING_HEADLINE,
  LANDING_SIGN_IN,
  LANDING_SUPPORTING,
} from './landing-copy.js';

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

function stubUnauthenticated() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith('/api/v1/me')) {
        return jsonResponse(401, {
          error: {
            code: 'UNAUTHENTICATED',
            message: 'Authentication required',
          },
        });
      }
      return jsonResponse(404, {
        error: { code: 'NOT_FOUND', message: 'Not found' },
      });
    }),
  );
}

function stubAuthenticatedEmptyHomes() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      const path = String(url);
      if (path.endsWith('/api/v1/me')) {
        return jsonResponse(200, {
          id: '11111111-1111-4111-8111-111111111111',
        });
      }
      if (path.includes('/api/auth/get-session')) {
        return jsonResponse(200, {
          user: {
            id: '11111111-1111-4111-8111-111111111111',
            email: 'alex@example.com',
            emailVerified: true,
          },
        });
      }
      if (path.includes('/api/v1/me/homes')) {
        return jsonResponse(200, []);
      }
      return jsonResponse(404, {
        error: { code: 'NOT_FOUND', message: 'Not found' },
      });
    }),
  );
}

describe('public landing page', () => {
  it('renders closed-alpha landing content on unauthenticated `/`', async () => {
    stubUnauthenticated();
    renderApp('/');

    expect(
      await screen.findByRole('heading', { name: LANDING_HEADLINE, level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText(LANDING_SUPPORTING)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: LANDING_CREATE_ACCOUNT }),
    ).toHaveAttribute('href', SIGN_UP_HREF);
    expect(screen.getByRole('link', { name: LANDING_SIGN_IN })).toHaveAttribute(
      'href',
      SIGN_IN_HREF,
    );
    expect(
      screen.getByRole('heading', { name: LANDING_ALPHA_TITLE, level: 2 }),
    ).toBeInTheDocument();
    expect(screen.getByText(LANDING_ALPHA_BODY)).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Welcome back', level: 1 }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
  });

  it('lists current features without five separate marketing cards', async () => {
    stubUnauthenticated();
    renderApp('/');
    await screen.findByRole('heading', { name: LANDING_HEADLINE, level: 1 });

    const features = screen.getByRole('region', { name: LANDING_FEATURES_HEADING });
    for (const feature of LANDING_FEATURES) {
      expect(
        within(features).getByRole('heading', {
          name: feature.title,
          level: 3,
        }),
      ).toBeInTheDocument();
      expect(within(features).getByText(feature.body)).toBeInTheDocument();
    }
    expect(within(features).queryByText(LANDING_COMING_HEADING)).not.toBeInTheDocument();
  });

  it('keeps coming-later copy out of the current feature list', async () => {
    stubUnauthenticated();
    renderApp('/');
    await screen.findByRole('heading', { name: LANDING_HEADLINE, level: 1 });

    const coming = screen.getByRole('region', { name: LANDING_COMING_HEADING });
    expect(
      within(coming).getByRole('heading', {
        name: LANDING_COMING_HEADING,
        level: 2,
      }),
    ).toBeInTheDocument();
    for (const item of LANDING_COMING_ITEMS) {
      expect(within(coming).getByText(item)).toBeInTheDocument();
    }
    expect(
      within(coming).queryByText(/create, assign, complete/i),
    ).not.toBeInTheDocument();
  });

  it('opens the existing sign-up form from Create account', async () => {
    stubUnauthenticated();
    renderApp('/');
    await screen.findByRole('heading', { name: LANDING_HEADLINE, level: 1 });

    await userEvent.click(
      screen.getByRole('link', { name: LANDING_CREATE_ACCOUNT }),
    );

    expect(
      await screen.findByRole('heading', {
        name: 'Create your account',
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /name/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: LANDING_HEADLINE, level: 1 }),
    ).not.toBeInTheDocument();
  });

  it('opens the existing sign-in form from Sign in', async () => {
    stubUnauthenticated();
    renderApp('/');
    await screen.findByRole('heading', { name: LANDING_HEADLINE, level: 1 });

    await userEvent.click(screen.getByRole('link', { name: LANDING_SIGN_IN }));

    expect(
      await screen.findByRole('heading', { name: 'Welcome back', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText('Sign in to your home.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: LANDING_HEADLINE, level: 1 }),
    ).not.toBeInTheDocument();
  });

  it('keeps authenticated `/` on Home discovery', async () => {
    stubAuthenticatedEmptyHomes();
    renderApp('/');

    expect(
      await screen.findByRole('heading', {
        name: 'Welcome to Roomies',
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: LANDING_HEADLINE, level: 1 }),
    ).not.toBeInTheDocument();
  });

  it('shows the existing sign-in form when `/` has a password-reset notice', async () => {
    stubUnauthenticated();
    const { router } = renderApp('/');
    await screen.findByRole('heading', { name: LANDING_HEADLINE, level: 1 });

    await router.navigate('/', { state: { passwordReset: true } });

    expect(
      await screen.findByRole('heading', { name: 'Welcome back', level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/your password has been updated/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: LANDING_HEADLINE, level: 1 }),
    ).not.toBeInTheDocument();
  });
});
