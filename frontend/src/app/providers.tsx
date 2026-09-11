import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { createAppQueryClient } from '../platform/query/query-client.js';

type AppProvidersProps = {
  children: ReactNode;
};

/**
 * Explicit platform provider composition.
 * Query client is created once per mount; cache is in-memory only (no persistence).
 */
export function AppProviders({ children }: AppProvidersProps) {
  const [queryClient] = useState(() => createAppQueryClient());

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
