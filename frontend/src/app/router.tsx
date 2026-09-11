import { createBrowserRouter } from 'react-router';
import { AppShell } from './app-shell.js';
import { FoundationHomePage } from './foundation-home-page.js';
import { NotFoundPage } from './not-found-page.js';
import { RouteErrorPage } from './route-error-page.js';

/**
 * Router foundation only:
 * - `/` — foundation placeholder
 * - `*` — not-found
 *
 * Future URL-backed Home context must not invent a final hierarchy here.
 * Active Home must not live in frontend global state or localStorage.
 */
export function createAppRouter() {
  return createBrowserRouter([
    {
      path: '/',
      element: <AppShell />,
      errorElement: <RouteErrorPage />,
      children: [
        {
          index: true,
          element: <FoundationHomePage />,
        },
        {
          path: '*',
          element: <NotFoundPage />,
        },
      ],
    },
  ]);
}
