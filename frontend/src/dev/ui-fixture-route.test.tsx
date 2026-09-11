import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { buildAppChildRoutes } from '../app/router.js';
import { renderApp } from '../test/render.js';

describe('development UI fixture route', () => {
  it('exists when development routes are enabled', async () => {
    renderApp('/__dev/ui', { includeDevRoutes: true });

    expect(
      await screen.findByRole('heading', {
        name: 'UI primitives fixture',
        level: 1,
      }),
    ).toBeInTheDocument();
  });

  it('is absent under production router configuration', async () => {
    const productionPaths = buildAppChildRoutes(false).map(
      (route) => route.path ?? (route.index ? '/' : undefined),
    );

    expect(productionPaths).not.toContain('__dev/ui');

    renderApp('/__dev/ui', { includeDevRoutes: false });

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Page not found', level: 1 }),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByRole('heading', { name: 'UI primitives fixture' }),
    ).not.toBeInTheDocument();
  });
});
