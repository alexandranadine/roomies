import { useQueryClient } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { Link, useOutletContext, useParams } from 'react-router';
import { HomeActivityFeed } from '../activity/home-activity-feed.js';
import { DocumentTitle } from '../components/document-title.js';
import { Alert, Button, Skeleton } from '../components/ui/index.js';
import { ApiError } from '../platform/api/index.js';
import { HousePulseSection } from '../pulse/house-pulse-section.js';
import { HousePulseSkeleton } from '../pulse/house-pulse-skeleton.js';
import { useHousePulse } from '../pulse/use-house-pulse.js';
import { clearPrivateHomeQueryState } from './clear-private-home-queries.js';
import type { HomeContext } from './home-context-api.js';
import { HomeQuickActions } from './home-quick-actions.js';
import { currentUserQueryKey } from './home-query-keys.js';
import { RoommateStrip } from './roommate-strip.js';
import { useHomeMemberships } from './use-home-memberships.js';

export type HomeShellOutletContext = {
  home: HomeContext;
  isAdmin: boolean;
  openAddTask: () => void;
  openInviteRoommate: () => void;
  openHomePhoto: () => void;
  openHomeActions: () => void;
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

function OverviewLayout({
  strip,
  pulse,
  actions,
  activity,
}: {
  strip: ReactNode;
  pulse: ReactNode;
  actions: ReactNode;
  activity: ReactNode;
}) {
  return (
    <div className="grid w-full grid-cols-1 gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)] lg:items-start lg:gap-x-8 lg:gap-y-4">
      <div className="min-w-0 lg:col-start-1 lg:row-start-1">{strip}</div>
      <aside className="min-w-0 lg:col-start-2 lg:row-span-3 lg:row-start-1">
        {pulse}
      </aside>
      <div className="min-w-0 lg:col-start-1 lg:row-start-2">{actions}</div>
      <div className="min-w-0 lg:col-start-1 lg:row-start-3">{activity}</div>
    </div>
  );
}

export function HomeOverviewPage() {
  const {
    home,
    isAdmin,
    openAddTask,
    openInviteRoommate,
    openHomePhoto,
    openHomeActions,
  } = useOutletContext<HomeShellOutletContext>();
  const { homeId: routeHomeId = '' } = useParams();
  const queryClient = useQueryClient();

  // URL homeId is authoritative; never render another Home's keyed Pulse here.
  const homeId = home.id === routeHomeId ? home.id : '';

  const pulseQuery = useHousePulse({
    homeId,
    enabled: homeId.length > 0,
  });
  const membershipsQuery = useHomeMemberships({
    homeId,
    enabled: homeId.length > 0,
  });

  useEffect(() => {
    if (
      isUnauthenticated(pulseQuery.error) ||
      isUnauthenticated(membershipsQuery.error)
    ) {
      clearPrivateHomeQueryState(queryClient);
      void queryClient.invalidateQueries({ queryKey: currentUserQueryKey });
    }
  }, [membershipsQuery.error, pulseQuery.error, queryClient]);

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
  const membershipsForHome =
    membershipsQuery.data !== undefined && homeId.length > 0
      ? membershipsQuery.data
      : undefined;
  const showMembershipsLoading =
    homeId.length > 0 &&
    membershipsQuery.isPending &&
    membershipsQuery.data === undefined;

  const roommateSlot = (
    <>
      {showMembershipsLoading ? (
        <div className="flex gap-3" aria-busy="true">
          <Skeleton className="size-10 rounded-full lg:size-16" announced />
          <Skeleton className="size-10 rounded-full lg:size-16" />
          <Skeleton className="size-10 rounded-full lg:size-16" />
        </div>
      ) : null}
      {membershipsForHome !== undefined ? (
        <RoommateStrip memberships={membershipsForHome} />
      ) : null}
    </>
  );

  const pulseSlot = (
    <>
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
    </>
  );

  return (
    <DocumentTitle title={`${home.name} · Roomies`}>
      <OverviewLayout
        strip={roommateSlot}
        pulse={pulseSlot}
        actions={
          <HomeQuickActions
            homeId={home.id}
            isAdmin={isAdmin}
            onOpenActions={openHomeActions}
            onAddTask={openAddTask}
            onInviteRoommate={openInviteRoommate}
            onHomePhoto={openHomePhoto}
          />
        }
        activity={
          homeId.length > 0 ? <HomeActivityFeed homeId={homeId} /> : null
        }
      />
    </DocumentTitle>
  );
}
