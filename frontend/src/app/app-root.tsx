import { RouterProvider } from 'react-router/dom';
import { AppProviders } from './providers.js';
import { createAppRouter } from './router.js';

const router = createAppRouter();

/**
 * Root application composition:
 * React root → providers (QueryClient) → router → shell/routes
 */
export function AppRoot() {
  return (
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  );
}
