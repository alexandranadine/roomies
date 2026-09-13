import { createBrowserRouter, type RouteObject } from 'react-router';
import { HomeDiscoveryPage } from '../homes/home-discovery-page.js';
import { HomeShellPage } from '../homes/home-shell-page.js';
import { InvitationLandingPage } from '../invitations/invitation-landing-page.js';
import { AppShell } from './app-shell.js';
import { NotFoundPage } from './not-found-page.js';
import { RequireAuth } from './require-auth.js';
import { RouteErrorPage } from './route-error-page.js';

export type CreateAppRouterOptions = {
  /**
   * When true, registers development-only routes such as `/__dev/ui`.
   * Defaults to `import.meta.env.DEV` so production builds never include them.
   */
  includeDevRoutes?: boolean;
};

/**
 * Router foundation:
 * - `/` — authenticated active-Home discovery
 * - `/homes/:homeId` — URL-backed authorized Home shell
 * - `/invitations/:invitationId` — signed-out invitation preview landing
 * - `/__dev/ui` — development visual QA fixture (never in production)
 * - `*` — not-found
 *
 * Active Home is the URL plus server authorization. It must not live in
 * frontend global state or localStorage.
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
      element: (
        <RequireAuth>
          <HomeDiscoveryPage />
        </RequireAuth>
      ),
    },
    {
      path: 'homes/:homeId',
      element: (
        <RequireAuth>
          <HomeShellPage />
        </RequireAuth>
      ),
    },
    {
      path: 'invitations/:invitationId',
      element: <InvitationLandingPage />,
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
