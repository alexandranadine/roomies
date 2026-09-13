import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../platform/api/index.js';
import { renderApp } from '../test/render.js';

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('application shell routes', () => {
  it('renders the authenticated discovery landing after a session check', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (String(url).endsWith('/api/v1/me')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: {
                  code: 'UNAUTHENTICATED',
                  message: 'Authentication required',
                },
              }),
              { status: 401, headers: { 'Content-Type': 'application/json' } },
            ),
          );
        }
        return Promise.resolve(new Response('{}', { status: 404 }));
      }),
    );

    renderApp('/');

    expect(
      await screen.findByText(/sign in to see your homes/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Roomies', level: 1 }),
    ).toBeInTheDocument();
  });

  it('registers the Home shell route', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (String(url).endsWith('/api/v1/me')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: {
                  code: 'UNAUTHENTICATED',
                  message: 'Authentication required',
                },
              }),
              { status: 401, headers: { 'Content-Type': 'application/json' } },
            ),
          );
        }
        return Promise.resolve(new Response('{}', { status: 404 }));
      }),
    );

    const { router } = renderApp('/homes/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

    expect(
      await screen.findByRole('heading', { name: 'Roomies', level: 1 }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(
      '/homes/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
  });

  it('renders the not-found page for unknown routes', async () => {
    renderApp('/does-not-exist');

    expect(
      await screen.findByRole('heading', { name: 'Page not found', level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/does not exist or is no longer available/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/does-not-exist/i)).not.toBeInTheDocument();
  });

  it('exposes header and main landmarks in the shell', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 'UNAUTHENTICATED',
              message: 'Authentication required',
            },
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    renderApp('/');

    await screen.findByRole('heading', { name: 'Roomies', level: 1 });

    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('banner').textContent).toMatch(/Roomies/);
  });
});
