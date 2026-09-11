import { createBrowserRouter, type RouteObject } from 'react-router';
import { AppShell } from './app-shell.js';
import { FoundationHomePage } from './foundation-home-page.js';
import { NotFoundPage } from './not-found-page.js';
import { RouteErrorPage } from './route-error-page.js';

export type CreateAppRouterOptions = {
  /**
   * When true, registers development-only routes such as `/__dev/ui`.
   * Defaults to `import.meta.env.DEV` so production builds never include them.
   */
  includeDevRoutes?: boolean;
};

/**
 * Router foundation only:
 * - `/` — foundation placeholder
 * - `/__dev/ui` — development visual QA fixture (never in production)
 * - `*` — not-found
 *
 * Future URL-backed Home context must not invent a final hierarchy here.
 * Active Home must not live in frontend global state or localStorage.
 */
export function createAppRouter(options: CreateAppRouterOptions = {}) {
  const includeDevRoutes = options.includeDevRoutes ?? import.meta.env.DEV;

  return createBrowserRouter([
    {
      path: '/',
      element: <AppShell />,
      errorElement: <RouteErrorPage />,
      children: buildAppChildRoutes(includeDevRoutes),
    },
  ]);
}

/** Exported for tests that assert development vs production route sets. */
export function buildAppChildRoutes(includeDevRoutes: boolean): RouteObject[] {
  const routes: RouteObject[] = [
    {
      index: true,
      element: <FoundationHomePage />,
    },
  ];

  if (includeDevRoutes) {
    const devRoute = createDevFixtureRoute();
    if (devRoute) {
      routes.push(devRoute);
    }
  }

  routes.push({
    path: '*',
    element: <NotFoundPage />,
  });

  return routes;
}

/**
 * Development fixture route. The `import.meta.env.PROD` branch is eliminated
 * from production bundles by Vite, so the fixture module is not shipped and
 * the path is not registered when callers pass `includeDevRoutes: false`.
 */
function createDevFixtureRoute(): RouteObject | undefined {
  if (import.meta.env.PROD) {
    return undefined;
  }

  return {
    path: '__dev/ui',
    lazy: () =>
      import('../dev/ui-fixture-page.js').then((module) => ({
        Component: module.UiFixturePage,
      })),
  };
}
