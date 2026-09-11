import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../test/render.js';

describe('application shell routes', () => {
  it('renders the root foundation placeholder', async () => {
    renderApp('/');

    expect(
      await screen.findByRole('heading', { name: 'Roomies', level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/frontend foundation is ready/i),
    ).toBeInTheDocument();
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
    renderApp('/');

    await screen.findByRole('heading', { name: 'Roomies', level: 1 });

    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('banner').textContent).toMatch(/Roomies/);
  });
});
