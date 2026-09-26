import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { PageContainer } from '../components/page-container.js';
import { Spinner } from '../components/ui/index.js';
import { ApiError } from '../platform/api/index.js';
import { InviteRoommateDialog } from '../roommates/invite-roommate-dialog.js';
import {
  recoverStaleHomeMembershipState,
  refreshHomeMembershipSurfaces,
} from '../roommates/refresh-home-membership-surfaces.js';
import { useCurrentHomeRole } from '../roommates/use-current-home-role.js';
import { CreateTaskDialog } from '../tasks/create-task-dialog.js';
import { handlePassiveAuthLoss } from './clear-private-home-queries.js';
import { HomeActionSheet } from './home-action-sheet.js';
import { HomeBottomNav } from './home-bottom-nav.js';
import { getHomeContext } from './home-context-api.js';
import type { HomeShellOutletContext } from './home-overview-page.js';
import { HomePhotoDialog } from './home-photo-dialog.js';
import { homeContextQueryKey } from './home-query-keys.js';
import { HomeShellFallbackHeader, HomeShellHeader } from './home-shell-header.js';
import { homeOverviewHref } from './wordmark-home-href.js';
import { useDesktopLayout, useWideLayout } from './use-desktop-layout.js';

function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

function isConcealedHome(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || error.code === 'NOT_FOUND')
  );
}

export type HomeChromeLayoutProps = {
  homeId: string;
  children: (context: HomeShellOutletContext) => ReactNode;
};

/**
 * Shared Home header, bottom nav, and quick actions for URL-backed and
 * resolved-Home authenticated routes.
 */
export function HomeChromeLayout({ homeId, children }: HomeChromeLayoutProps) {
  const queryClient = useQueryClient();
  const { isAdmin } = useCurrentHomeRole(homeId);
  const isDesktop = useDesktopLayout();
  const isWide = useWideLayout();

  const [taskOpen, setTaskOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);

  const contextQuery = useQuery({
    queryKey: homeContextQueryKey(homeId),
    queryFn: ({ signal }) => getHomeContext(homeId, signal),
    enabled: homeId.length > 0,
  });

  useEffect(() => {
    if (isUnauthenticated(contextQuery.error)) {
      handlePassiveAuthLoss(queryClient);
    }
  }, [contextQuery.error, queryClient]);

  if (isConcealedHome(contextQuery.error)) {
    return (
      <>
        <HomeShellFallbackHeader to="/" />
        <PageContainer>
          <div className="flex flex-col gap-4 py-6">
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
        </PageContainer>
      </>
    );
  }

  const home =
    contextQuery.data !== undefined && contextQuery.data.id === homeId
      ? contextQuery.data
      : undefined;

  if (home === undefined) {
    return (
      <>
        <HomeShellFallbackHeader to={homeOverviewHref(homeId)} />
        <PageContainer>
          <div className="flex flex-col gap-3 py-6">
            <Spinner label="Loading this Home" />
          </div>
        </PageContainer>
      </>
    );
  }

  function handleUnauthenticated() {
    handlePassiveAuthLoss(queryClient);
  }

  const outletContext: HomeShellOutletContext = {
    home,
    isAdmin,
    openAddTask: () => {
      setTaskOpen(true);
    },
    openInviteRoommate: () => {
      if (isAdmin) {
        setInviteOpen(true);
      }
    },
    openHomePhoto: () => {
      setPhotoOpen(true);
    },
    openHomeActions: () => {
      setActionsOpen(true);
    },
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <HomeShellHeader
        home={home}
        isDesktop={isDesktop}
        isWide={isWide}
        onAdd={() => {
          setActionsOpen(true);
        }}
      />

      <div className={isDesktop ? 'flex-1 pb-8' : 'flex-1 pb-28'}>
        <PageContainer className="py-2 sm:py-4 lg:py-6">
          {children(outletContext)}
        </PageContainer>
      </div>

      {isDesktop ? null : (
        <HomeBottomNav
          homeId={home.id}
          onOpenActions={() => {
            setActionsOpen(true);
          }}
        />
      )}

      <HomeActionSheet
        open={actionsOpen}
        onOpenChange={setActionsOpen}
        isAdmin={isAdmin}
        hasPhoto={home.hasPhoto}
        onAddTask={() => {
          setTaskOpen(true);
        }}
        onInviteRoommate={() => {
          setInviteOpen(true);
        }}
        onHomePhoto={() => {
          setPhotoOpen(true);
        }}
      />
      <CreateTaskDialog
        homeId={home.id}
        timeZone={home.timezone}
        open={taskOpen}
        onOpenChange={setTaskOpen}
      />
      {isAdmin ? (
        <InviteRoommateDialog
          homeId={home.id}
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          onCreated={() => refreshHomeMembershipSurfaces(queryClient, home.id)}
          onStaleMembership={() =>
            recoverStaleHomeMembershipState(queryClient, home.id)
          }
          onUnauthenticated={handleUnauthenticated}
        />
      ) : null}
      <HomePhotoDialog
        home={home}
        open={photoOpen}
        onOpenChange={setPhotoOpen}
      />
    </div>
  );
}
