import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, Outlet, useParams } from 'react-router';
import { DocumentTitle } from '../components/document-title.js';
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
import { clearPrivateHomeQueryState } from './clear-private-home-queries.js';
import { HomeActionSheet } from './home-action-sheet.js';
import { HomeBottomNav } from './home-bottom-nav.js';
import { getHomeContext } from './home-context-api.js';
import type { HomeShellOutletContext } from './home-overview-page.js';
import { HomePhotoDialog } from './home-photo-dialog.js';
import { currentUserQueryKey, homeContextQueryKey } from './home-query-keys.js';
import { HomeShellFallbackHeader, HomeShellHeader } from './home-shell-header.js';
import { useDesktopLayout, useWideLayout } from './use-desktop-layout.js';

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
  const { isAdmin } = useCurrentHomeRole(validHomeId ? homeId : '');
  const isDesktop = useDesktopLayout();
  const isWide = useWideLayout();

  const [taskOpen, setTaskOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);

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
        <HomeShellFallbackHeader
          to={`/homes/${encodeURIComponent(homeId)}`}
        />
        <PageContainer>
          <div className="flex flex-col gap-3 py-6">
            <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
              Home
            </h1>
            <Spinner label="Loading this Home" />
          </div>
        </PageContainer>
      </DocumentTitle>
    );
  }

  function handleUnauthenticated() {
    clearPrivateHomeQueryState(queryClient);
    void queryClient.invalidateQueries({ queryKey: currentUserQueryKey });
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
          <Outlet context={outletContext} />
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
