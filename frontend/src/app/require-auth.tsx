import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { DocumentTitle } from '../components/document-title.js';
import { Spinner } from '../components/ui/index.js';
import { clearPrivateHomeQueryState } from '../homes/clear-private-home-queries.js';
import { currentUserQueryKey } from '../homes/home-query-keys.js';
import { ApiError } from '../platform/api/index.js';
import { getCurrentUser } from '../users/current-user-api.js';

function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

function AuthLanding({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <DocumentTitle title={title}>
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-text-primary sm:text-3xl">
          Roomies
        </h1>
        {children}
      </div>
    </DocumentTitle>
  );
}

/**
 * Session gate for product routes. Invitation landing stays outside this wrap.
 * Home data is cleared on authentication loss so a prior Home cannot linger.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: currentUserQueryKey,
    queryFn: ({ signal }) => getCurrentUser(signal),
    retry: false,
  });

  useEffect(() => {
    if (isUnauthenticated(query.error)) {
      clearPrivateHomeQueryState(queryClient);
    }
  }, [query.error, queryClient]);

  if (query.isPending) {
    return (
      <AuthLanding title="Roomies">
        <Spinner label="Checking your session" />
      </AuthLanding>
    );
  }

  if (isUnauthenticated(query.error)) {
    return (
      <AuthLanding title="Sign in · Roomies">
        <p className="max-w-prose text-base text-text-secondary">
          Sign in to see your Homes.
        </p>
      </AuthLanding>
    );
  }

  if (query.error !== null || query.data === undefined) {
    return (
      <AuthLanding title="Roomies">
        <p className="max-w-prose text-base text-text-secondary">
          Couldn’t confirm your session. Try again in a moment.
        </p>
      </AuthLanding>
    );
  }

  return children;
}
