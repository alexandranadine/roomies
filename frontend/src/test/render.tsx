import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { AppShell } from '../app/app-shell.js';
import { FoundationHomePage } from '../app/foundation-home-page.js';
import { NotFoundPage } from '../app/not-found-page.js';
import { RouteErrorPage } from '../app/route-error-page.js';
import { createAppQueryClient } from '../platform/query/query-client.js';

function createTestRouter(initialEntry: string) {
  return createMemoryRouter(
    [
      {
        path: '/',
        element: <AppShell />,
        errorElement: <RouteErrorPage />,
        children: [
          { index: true, element: <FoundationHomePage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
    { initialEntries: [initialEntry] },
  );
}

export function renderApp(initialEntry = '/') {
  const queryClient = createAppQueryClient();
  const router = createTestRouter(initialEntry);

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  }

  return {
    queryClient,
    ...render(<RouterProvider router={router} />, { wrapper: Wrapper }),
  };
}

export function renderWithProviders(ui: ReactElement) {
  const queryClient = createAppQueryClient();
  return {
    queryClient,
    ...render(ui, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    }),
  };
}
