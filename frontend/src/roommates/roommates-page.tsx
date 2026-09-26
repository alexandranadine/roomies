import { useMutation, useQueryClient } from '@tanstack/react-query';
import { UserPlusIcon } from '@heroicons/react/24/outline';
import { useEffect, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router';
import { DocumentTitle } from '../components/document-title.js';
import { Alert, Button, Skeleton } from '../components/ui/index.js';
import { cn } from '../components/ui/cn.js';
import { clearPrivateHomeQueryState } from '../homes/clear-private-home-queries.js';
import type { HomeShellOutletContext } from '../homes/home-overview-page.js';
import { currentUserQueryKey } from '../homes/home-query-keys.js';
import { useHomeMemberships } from '../homes/use-home-memberships.js';
import type { CreatedInvitation } from '../invitations/create-invitation-api.js';
import { ApiError } from '../platform/api/index.js';
import type { MembershipRole } from './change-membership-role-api.js';
import { changeMembershipRole } from './change-membership-role-api.js';
import { InviteRoommateDialog } from './invite-roommate-dialog.js';
import { LeaveHomeDialog } from './leave-home-dialog.js';
import { PendingInvitePanel } from './pending-invite-panel.js';
import {
  recoverStaleHomeMembershipState,
  refreshHomeMembershipSurfaces,
} from './refresh-home-membership-surfaces.js';
import { RemoveRoommateDialog } from './remove-roommate-dialog.js';
import { RoommateMemberRow } from './roommate-member-row.js';
import { changeRoleErrorMessage } from './roommates-errors.js';
import { useCurrentHomeRole } from './use-current-home-role.js';

function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

function isConcealedScope(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || error.code === 'NOT_FOUND')
  );
}

function isTransientListError(error: unknown): boolean {
  return !(
    error instanceof ApiError &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}

type PendingRemove = {
  membershipId: string;
  name: string;
};

export function RoommatesPage() {
  const { home } = useOutletContext<HomeShellOutletContext>();
  const { homeId: routeHomeId = '' } = useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const homeId = home.id === routeHomeId ? home.id : '';

  const membershipsQuery = useHomeMemberships({
    homeId,
    enabled: homeId.length > 0,
  });
  const { role, isAdmin } = useCurrentHomeRole(homeId);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<PendingRemove | null>(
    null,
  );
  const [pendingInvite, setPendingInvite] = useState<CreatedInvitation | null>(
    null,
  );
  const [roleError, setRoleError] = useState<string | null>(null);

  const roleMutation = useMutation({
    mutationFn: (input: { membershipId: string; role: MembershipRole }) =>
      changeMembershipRole({
        homeId,
        membershipId: input.membershipId,
        role: input.role,
      }),
    retry: false,
  });

  function handleUnauthenticated() {
    clearPrivateHomeQueryState(queryClient);
    void queryClient.invalidateQueries({ queryKey: currentUserQueryKey });
  }

  useEffect(() => {
    setInviteOpen(false);
    setLeaveOpen(false);
    setPendingRemove(null);
    setPendingInvite(null);
    setRoleError(null);
  }, [homeId]);

  useEffect(() => {
    if (isUnauthenticated(membershipsQuery.error)) {
      clearPrivateHomeQueryState(queryClient);
      void queryClient.invalidateQueries({ queryKey: currentUserQueryKey });
    }
  }, [membershipsQuery.error, queryClient]);

  async function handleStaleMembership() {
    await recoverStaleHomeMembershipState(queryClient, homeId);
  }

  async function refreshAfterStructuralChange() {
    await refreshHomeMembershipSurfaces(queryClient, homeId);
  }

  async function handleChangeRole(
    membershipId: string,
    nextRole: MembershipRole,
  ) {
    if (roleMutation.isPending) {
      return;
    }
    setRoleError(null);
    try {
      await roleMutation.mutateAsync({ membershipId, role: nextRole });
      await refreshAfterStructuralChange();
    } catch (error) {
      if (isUnauthenticated(error)) {
        handleUnauthenticated();
        return;
      }
      if (isConcealedScope(error)) {
        await handleStaleMembership();
      } else if (error instanceof ApiError && error.status === 403) {
        await refreshAfterStructuralChange();
      }
      setRoleError(changeRoleErrorMessage(error));
    }
  }

  function handleLeftHome() {
    clearPrivateHomeQueryState(queryClient);
    void navigate('/', { replace: true });
  }

  if (membershipsQuery.isError && isConcealedScope(membershipsQuery.error)) {
    return (
      <DocumentTitle title="Home unavailable · Roomies">
        <div className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
            This Home isn’t available
          </h1>
          <p className="max-w-prose text-base text-text-secondary">
            It may not exist, or you may not be able to open it right now.
          </p>
        </div>
      </DocumentTitle>
    );
  }

  const memberships = membershipsQuery.data?.memberships ?? [];
  const currentMembershipId = membershipsQuery.data?.currentMembershipId ?? '';
  const showLoading =
    membershipsQuery.isPending && membershipsQuery.data === undefined;
  const showRoster = membershipsQuery.isSuccess && memberships.length > 0;
  const justYou = showRoster && memberships.length === 1;

  return (
    <DocumentTitle title={`Roommates · ${home.name} · Roomies`}>
      <div
        data-testid="roommates-page"
        className="mx-auto flex w-full max-w-[980px] flex-col gap-5"
      >
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
              Roommates
            </h1>
            <p className="text-sm text-text-secondary">
              The people sharing this Home.
            </p>
            {justYou ? (
              <p className="text-xs font-medium text-text-muted">
                It’s just you here for now.
              </p>
            ) : null}
          </div>
          {isAdmin ? (
            <Button
              type="button"
              className="shrink-0 self-start"
              icon={<UserPlusIcon className="size-4" aria-hidden="true" />}
              onClick={() => {
                setInviteOpen(true);
              }}
            >
              Invite roommate
            </Button>
          ) : null}
        </header>

        {isAdmin ? (
          <InviteRoommateDialog
            homeId={homeId}
            open={inviteOpen}
            onOpenChange={setInviteOpen}
            onCreated={refreshAfterStructuralChange}
            onInvitationCreated={setPendingInvite}
            onStaleMembership={handleStaleMembership}
            onUnauthenticated={handleUnauthenticated}
          />
        ) : null}

        {isAdmin && pendingInvite !== null && !inviteOpen ? (
          <PendingInvitePanel
            homeId={homeId}
            created={pendingInvite}
            onRevoked={() => {
              setPendingInvite(null);
            }}
            onStaleMembership={handleStaleMembership}
            onUnauthenticated={handleUnauthenticated}
          />
        ) : null}

        {roleError ? <Alert variant="danger">{roleError}</Alert> : null}

        {showLoading ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-20 w-full rounded-xl" announced />
            <Skeleton className="h-20 w-full rounded-xl" />
          </div>
        ) : null}

        {membershipsQuery.isError &&
        isTransientListError(membershipsQuery.error) ? (
          <Alert variant="danger" title="Couldn’t load roommates">
            <p className="mb-3">Something went wrong. Try again.</p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                void membershipsQuery.refetch();
              }}
            >
              Retry
            </Button>
          </Alert>
        ) : null}

        {showRoster ? (
          <section aria-labelledby="roster-heading" className="flex flex-col gap-2">
            <h2
              id="roster-heading"
              className="text-base font-semibold tracking-tight text-text-primary"
            >
              {memberships.length}{' '}
              {memberships.length === 1 ? 'roommate' : 'roommates'}
            </h2>
            <ul
              className={cn(
                'm-0 grid list-none grid-cols-1 gap-2 p-0',
                memberships.length > 1 && 'lg:grid-cols-2 lg:gap-3',
              )}
            >
              {memberships.map((member) => (
                <RoommateMemberRow
                  key={member.membershipId}
                  name={member.name}
                  isCurrent={member.membershipId === currentMembershipId}
                  currentUserRole={role}
                  showAdminActions={isAdmin}
                  actionsDisabled={roleMutation.isPending}
                  onMakeAdmin={() => {
                    void handleChangeRole(member.membershipId, 'ADMIN');
                  }}
                  onMakeRoommate={() => {
                    void handleChangeRole(member.membershipId, 'ROOMMATE');
                  }}
                  onRemove={() => {
                    setPendingRemove({
                      membershipId: member.membershipId,
                      name: member.name,
                    });
                  }}
                />
              ))}
            </ul>
          </section>
        ) : null}

        {currentMembershipId.length > 0 ? (
          <section
            aria-labelledby="your-home-heading"
            className="rounded-xl border border-border bg-surface px-4 py-4 shadow-card"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
              <div className="flex min-w-0 flex-col gap-1">
                <h2
                  id="your-home-heading"
                  className="text-base font-semibold tracking-tight text-text-primary"
                >
                  Your home
                </h2>
                <p className="max-w-prose text-sm text-text-secondary">
                  You’ll lose current access to this Home. Shared household
                  history stays with the Home.
                </p>
              </div>
              <Button
                type="button"
                variant="subtle"
                className="shrink-0 self-start px-2 text-accent-coral-text! hover:bg-transparent hover:text-accent-coral-text!"
                onClick={() => {
                  setLeaveOpen(true);
                }}
              >
                Leave Home
              </Button>
            </div>
            <LeaveHomeDialog
              homeId={homeId}
              homeName={home.name}
              membershipId={currentMembershipId}
              open={leaveOpen}
              onOpenChange={setLeaveOpen}
              onLeft={handleLeftHome}
              onStaleMembership={handleStaleMembership}
              onUnauthenticated={handleUnauthenticated}
            />
          </section>
        ) : null}

        {pendingRemove !== null ? (
          <RemoveRoommateDialog
            homeId={homeId}
            membershipId={pendingRemove.membershipId}
            roommateName={pendingRemove.name}
            open
            onOpenChange={(next) => {
              if (!next) {
                setPendingRemove(null);
              }
            }}
            onRemoved={refreshAfterStructuralChange}
            onStaleMembership={handleStaleMembership}
            onUnauthenticated={handleUnauthenticated}
          />
        ) : null}
      </div>
    </DocumentTitle>
  );
}
