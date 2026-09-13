import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import { DocumentTitle } from '../components/document-title.js';
import { Alert, Button, Card, Spinner } from '../components/ui/index.js';
import { ApiError } from '../platform/api/index.js';
import { shouldRetryQuery } from '../platform/query/query-client.js';
import { currentUserHomesQueryKey } from '../homes/home-query-keys.js';
import { acceptInvitation } from './accept-api.js';
import {
  getInvitationAuthSession,
  invitationAuthSessionQueryKey,
} from './auth-session-api.js';
import {
  clearCapturedInvitationSecret,
  getCapturedInvitationSecret,
} from './capture-invitation-fragment.js';
import { invitationPreviewQueryKey, previewInvitation } from './preview-api.js';

const INVITATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatExpiration(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) {
    return iso;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function isUnavailableError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === 'INVITATION_NOT_AVAILABLE' ||
      error.code === 'INVALID_PATH_INPUT' ||
      error.status === 404)
  );
}

export function InvitationLandingPage() {
  const { invitationId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const secret = getCapturedInvitationSecret();
  const validInvitationId = INVITATION_ID_PATTERN.test(invitationId);
  const canPreview = secret !== null && validInvitationId;

  const query = useQuery({
    queryKey: invitationPreviewQueryKey(invitationId),
    queryFn: ({ signal }) => {
      if (secret === null) {
        throw new Error('Invitation secret is not available in memory');
      }
      return previewInvitation({ invitationId, secret, signal });
    },
    enabled: canPreview,
    staleTime: 0,
    gcTime: 0,
    retry: shouldRetryQuery,
  });
  const sessionQuery = useQuery({
    queryKey: invitationAuthSessionQueryKey,
    queryFn: ({ signal }) => getInvitationAuthSession(signal),
    retry: false,
  });
  const acceptance = useMutation({
    mutationFn: () => {
      if (secret === null) {
        throw new Error('Invitation secret is not available in memory');
      }
      return acceptInvitation({ invitationId, secret });
    },
    retry: false,
    onSuccess: async (result) => {
      clearCapturedInvitationSecret();
      queryClient.removeQueries({
        queryKey: invitationPreviewQueryKey(invitationId),
        exact: true,
      });
      await queryClient.invalidateQueries({
        queryKey: currentUserHomesQueryKey,
      });
      void navigate(`/homes/${encodeURIComponent(result.homeId)}`, {
        replace: true,
      });
    },
  });

  if (secret === null) {
    return (
      <InvitationPageFrame title="Invitation link required · Roomies">
        <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
          Use the original invitation link
        </h1>
        <Alert
          variant="warning"
          title="This invitation link can’t be opened here"
        >
          Please use the original invitation link again. Roomies does not store
          the invitation secret after it is removed from the address bar.
        </Alert>
      </InvitationPageFrame>
    );
  }

  if (!validInvitationId) {
    return (
      <InvitationPageFrame title="Invitation unavailable · Roomies">
        <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
          Invitation unavailable
        </h1>
        <Alert variant="warning" title="This invitation isn’t available">
          The invitation may have expired or is no longer valid. Ask a Home
          Admin for a new invitation if you still need access.
        </Alert>
      </InvitationPageFrame>
    );
  }

  if (query.isPending) {
    return (
      <InvitationPageFrame title="Invitation · Roomies">
        <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
          Invitation
        </h1>
        <p className="flex items-center gap-2 text-text-secondary">
          <Spinner label="Loading invitation" />
        </p>
      </InvitationPageFrame>
    );
  }

  if (query.isError && isUnavailableError(query.error)) {
    return (
      <InvitationPageFrame title="Invitation unavailable · Roomies">
        <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
          Invitation unavailable
        </h1>
        <Alert variant="warning" title="This invitation isn’t available">
          The invitation may have expired or is no longer valid. Ask a Home
          Admin for a new invitation if you still need access.
        </Alert>
      </InvitationPageFrame>
    );
  }

  if (query.isError || query.data === undefined) {
    return (
      <InvitationPageFrame title="Invitation · Roomies">
        <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
          Invitation
        </h1>
        <Alert variant="danger" title="Couldn’t load this invitation">
          Something went wrong. Try the original invitation link again in a
          moment.
        </Alert>
      </InvitationPageFrame>
    );
  }

  const invitation = query.data.invitation;
  const session = sessionQuery.data;
  const signedIn = session !== null && session !== undefined;
  const sessionEmail = session?.user.email.trim().toLowerCase();
  const matchingEmail =
    signedIn && session.user.emailVerified && sessionEmail === invitation.email;
  const acceptanceError =
    acceptance.error instanceof ApiError ? acceptance.error.code : undefined;

  return (
    <InvitationPageFrame title={`${invitation.home.name} invitation · Roomies`}>
      <Card padding="lg" className="flex max-w-lg flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
          You’re invited to {invitation.home.name}
        </h1>
        <p className="text-base text-text-secondary">
          This invitation was sent to {invitation.email}.
        </p>
        <p className="text-sm text-text-secondary">
          Expires {formatExpiration(invitation.expiresAt)}.
        </p>
        <div className="flex flex-col gap-2">
          {sessionQuery.isPending ? (
            <p className="flex items-center gap-2 text-sm text-text-secondary">
              <Spinner label="Checking sign-in status" />
            </p>
          ) : null}
          {!sessionQuery.isPending && !signedIn ? (
            <>
              <Button disabled>Join Home</Button>
              <p className="text-sm text-text-secondary">
                Sign in to Roomies, then reopen the original invitation link.
                The invitation secret is intentionally not saved across a page
                reload.
              </p>
            </>
          ) : null}
          {signedIn && !session.user.emailVerified ? (
            <>
              <Button disabled>Join Home</Button>
              <Alert variant="warning" title="Verify your email first">
                Verify your current Roomies email, then reopen this invitation
                link.
              </Alert>
            </>
          ) : null}
          {signedIn &&
          session.user.emailVerified &&
          sessionEmail !== invitation.email ? (
            <>
              <Button disabled>Join Home</Button>
              <Alert variant="warning" title="Use the invited account">
                Sign in with the verified Roomies account that received this
                invitation.
              </Alert>
            </>
          ) : null}
          {matchingEmail ? (
            <Button
              loading={acceptance.isPending}
              onClick={() => acceptance.mutate()}
            >
              Join Home
            </Button>
          ) : null}
          {acceptanceError === 'EMAIL_NOT_VERIFIED' ? (
            <Alert variant="warning" title="Verify your email first">
              Verify your current Roomies email, then reopen this invitation
              link.
            </Alert>
          ) : null}
          {acceptanceError === 'EMAIL_MISMATCH' ? (
            <Alert variant="warning" title="Use the invited account">
              Sign in with the verified Roomies account that received this
              invitation.
            </Alert>
          ) : null}
          {acceptanceError === 'ALREADY_HOME_MEMBER' ? (
            <Alert variant="warning" title="Already a Home member">
              Your current Roomies account already belongs to this Home.
            </Alert>
          ) : null}
          {acceptanceError === 'INVITATION_NOT_AVAILABLE' ? (
            <Alert variant="warning" title="This invitation isn’t available">
              Ask a Home Admin for a new invitation if you still need access.
            </Alert>
          ) : null}
          {acceptance.isError && acceptanceError === undefined ? (
            <Alert variant="danger" title="Couldn’t join this Home">
              Something went wrong. Try again in a moment.
            </Alert>
          ) : null}
        </div>
      </Card>
    </InvitationPageFrame>
  );
}

function InvitationPageFrame({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <DocumentTitle title={title}>
      <div className="flex flex-col gap-4">{children}</div>
    </DocumentTitle>
  );
}
