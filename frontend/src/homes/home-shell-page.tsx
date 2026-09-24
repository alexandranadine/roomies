import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, Outlet, useParams } from 'react-router';
import { DocumentTitle } from '../components/document-title.js';
import { Spinner } from '../components/ui/index.js';
import { ApiError } from '../platform/api/index.js';
import { clearPrivateHomeQueryState } from './clear-private-home-queries.js';
import { getHomeContext } from './home-context-api.js';
import type { HomeShellOutletContext } from './home-overview-page.js';
import { HomeAvatar } from './home-avatar.js';
import { HomePrimaryNav } from './home-primary-nav.js';
import { currentUserQueryKey, homeContextQueryKey } from './home-query-keys.js';

const HOME_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

function isConcealedHome(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || error.code === 'NOT_FOUND')
  );
}

/**
 * URL-backed Home shell. Query data is keyed by homeId so a previous Home
 * cannot render as the current one while the next context loads.
 */
export function HomeShellPage() {
  const { homeId = '' } = useParams();
  const queryClient = useQueryClient();
  const validHomeId = HOME_ID_PATTERN.test(homeId);

  const contextQuery = useQuery({
    queryKey: homeContextQueryKey(homeId),
    queryFn: ({ signal }) => getHomeContext(homeId, signal),
    enabled: validHomeId,
  });

  useEffect(() => {
    if (isUnauthenticated(contextQuery.error)) {
      clearPrivateHomeQueryState(queryClient);
      void queryClient.invalidateQueries({ queryKey: currentUserQueryKey });
    }
  }, [contextQuery.error, queryClient]);

  if (!validHomeId || isConcealedHome(contextQuery.error)) {
    return (
      <DocumentTitle title="Home unavailable · Roomies">
        <div className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
            This Home isn’t available
          </h1>
          <p className="max-w-prose text-base text-text-secondary">
            It may not exist, or you may not be able to open it right now.
          </p>
          <p>
            <Link
              to="/"
              className="font-medium text-brand underline-offset-4 hover:text-brand-hover hover:underline focus-visible:rounded-sm"
            >
              Back to your Homes
            </Link>
          </p>
        </div>
      </DocumentTitle>
    );
  }

  const home =
    contextQuery.data !== undefined && contextQuery.data.id === homeId
      ? contextQuery.data
      : undefined;

  if (home === undefined) {
    return (
      <DocumentTitle title="Home · Roomies">
        <div className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
            Home
          </h1>
          <Spinner label="Loading this Home" />
        </div>
      </DocumentTitle>
    );
  }

  const outletContext: HomeShellOutletContext = { home };

  return (
    <div className="flex flex-col gap-4">
      <p>
        <Link
          to="/"
          className="text-sm font-medium text-brand underline-offset-4 hover:text-brand-hover hover:underline focus-visible:rounded-sm"
        >
          Your Homes
        </Link>
      </p>
      <p className="flex items-center gap-2">
        <HomeAvatar
          homeId={home.id}
          name={home.name}
          hasPhoto={home.hasPhoto}
          size="sm"
        />
        <span className="text-sm font-medium text-text-secondary">
          {home.name}
        </span>
      </p>
      <HomePrimaryNav homeId={home.id} />
      <Outlet context={outletContext} />
    </div>
  );
}
