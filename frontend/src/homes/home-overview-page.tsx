import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, useOutletContext, useParams } from 'react-router';
import { DocumentTitle } from '../components/document-title.js';
import { Alert, Button } from '../components/ui/index.js';
import { ApiError } from '../platform/api/index.js';
import { HousePulseSection } from '../pulse/house-pulse-section.js';
import { HousePulseSkeleton } from '../pulse/house-pulse-skeleton.js';
import { useHousePulse } from '../pulse/use-house-pulse.js';
import { clearPrivateHomeQueryState } from './clear-private-home-queries.js';
import type { HomeContext } from './home-context-api.js';
import { HomePhotoSection } from './home-photo-section.js';
import { currentUserQueryKey } from './home-query-keys.js';

export type HomeShellOutletContext = {
  home: HomeContext;
};

function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

function isConcealedHome(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || error.code === 'NOT_FOUND')
  );
}

function isTransientPulseError(error: unknown): boolean {
  return !(
    error instanceof ApiError &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}

export function HomeOverviewPage() {
  const { home } = useOutletContext<HomeShellOutletContext>();
  const { homeId: routeHomeId = '' } = useParams();
  const queryClient = useQueryClient();

  // URL homeId is authoritative; never render another Home's keyed Pulse here.
  const homeId = home.id === routeHomeId ? home.id : '';

  const pulseQuery = useHousePulse({
    homeId,
    enabled: homeId.length > 0,
  });

  useEffect(() => {
    if (isUnauthenticated(pulseQuery.error)) {
      clearPrivateHomeQueryState(queryClient);
      void queryClient.invalidateQueries({ queryKey: currentUserQueryKey });
    }
  }, [pulseQuery.error, queryClient]);

  if (pulseQuery.isError && isConcealedHome(pulseQuery.error)) {
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

  const showPulseLoading =
    homeId.length === 0 ||
    (pulseQuery.isPending && pulseQuery.data === undefined);
  const pulseForHome =
    pulseQuery.data !== undefined && homeId.length > 0
      ? pulseQuery.data
      : undefined;

  return (
    <DocumentTitle title={`${home.name} · Roomies`}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-text-primary sm:text-3xl">
            {home.name}
          </h1>
          <p className="max-w-prose text-base text-text-secondary">
            Shared life for this Home. Use Tasks for chores and Maintenance for
            upkeep that needs attention.
          </p>
          <HomePhotoSection home={home} />
        </div>

        {showPulseLoading ? <HousePulseSkeleton /> : null}

        {pulseQuery.isError && isTransientPulseError(pulseQuery.error) ? (
          <Alert variant="danger" title="Couldn’t load House Pulse">
            <p className="mb-3">Something went wrong. Try again.</p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                void pulseQuery.refetch();
              }}
            >
              Retry
            </Button>
          </Alert>
        ) : null}

        {pulseForHome !== undefined && !showPulseLoading ? (
          <HousePulseSection homeId={homeId} pulse={pulseForHome} />
        ) : null}

        <p className="flex flex-wrap gap-x-4 gap-y-2">
          <Link
            to={`/homes/${encodeURIComponent(home.id)}/tasks`}
            className="font-medium text-brand underline-offset-4 hover:text-brand-hover hover:underline focus-visible:rounded-sm"
          >
            Open Tasks
          </Link>
          <Link
            to={`/homes/${encodeURIComponent(home.id)}/maintenance`}
            className="font-medium text-brand underline-offset-4 hover:text-brand-hover hover:underline focus-visible:rounded-sm"
          >
            Open Maintenance
          </Link>
        </p>
      </div>
    </DocumentTitle>
  );
}
