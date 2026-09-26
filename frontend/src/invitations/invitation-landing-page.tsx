import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ExclamationCircleIcon,
  HomeIcon,
} from '@heroicons/react/24/outline';
import type { ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import { AuthIconWell, AuthPageLayout } from '../auth/auth-page-layout.js';
import { CredentialForm } from '../auth/credential-form.js';
import { SignOutButton } from '../auth/sign-out-button.js';
import { UnverifiedEmailNotice } from '../auth/unverified-email-notice.js';
import {
  VERIFY_EMAIL_BEFORE_JOINING,
  VERIFY_EMAIL_BEFORE_JOINING_TITLE,
} from '../auth/verification-copy.js';
import { Alert, Button, Card, Spinner } from '../components/ui/index.js';
import { homeMembershipsKeys } from '../homes/home-memberships-query-keys.js';
import { currentUserHomesQueryKey } from '../homes/home-query-keys.js';
import { ApiError } from '../platform/api/index.js';
import { shouldRetryQuery } from '../platform/query/query-client.js';
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
      await queryClient.invalidateQueries({
        queryKey: homeMembershipsKeys.all(result.homeId),
      });
      void navigate(`/homes/${encodeURIComponent(result.homeId)}`, {
        replace: true,
      });
    },
  });
  if (secret === null) {
    return (
      <InvitationStatusPage
        title="Invitation link required · Roomies"
        heading="Use the original invitation link"
      >
        <Alert
          variant="warning"
          title="This invitation link can’t be opened here"
        >
          Please use the original invitation link again. Roomies does not store
          the invitation secret after it is removed from the address bar.
        </Alert>
      </InvitationStatusPage>
    );
  }

  if (!validInvitationId) {
    return (
      <InvitationUnavailablePage title="Invitation unavailable · Roomies" />
    );
  }

  if (query.isPending) {
    return (
      <InvitationStatusPage title="Invitation · Roomies" heading="Invitation">
        <p className="flex items-center gap-2 text-text-secondary">
          <Spinner label="Loading invitation" />
        </p>
      </InvitationStatusPage>
    );
  }

  if (query.isError && isUnavailableError(query.error)) {
    return (
      <InvitationUnavailablePage title="Invitation unavailable · Roomies" />
    );
  }

  if (query.isError || query.data === undefined) {
    return (
      <InvitationStatusPage title="Invitation · Roomies" heading="Invitation">
        <Alert variant="danger" title="Couldn’t load this invitation">
          Something went wrong. Try the original invitation link again in a
          moment.
        </Alert>
      </InvitationStatusPage>
    );
  }

  const invitation = query.data.invitation;
  const session = sessionQuery.data;
  const signedIn = session !== null && session !== undefined;
  const sessionEmail = session?.user.email.trim().toLowerCase();
  const invitedEmail = invitation.email.trim().toLowerCase();
  const matchingEmail =
    signedIn && session.user.emailVerified && sessionEmail === invitedEmail;
  const emailMismatch = signedIn && sessionEmail !== invitedEmail;
  const needsVerification =
    signedIn && !emailMismatch && session.user.emailVerified === false;
  const acceptanceError =
    acceptance.error instanceof ApiError ? acceptance.error.code : undefined;

  return (
    <AuthPageLayout
      title={`${invitation.home.name} invitation · Roomies`}
      size="invite"
    >
      <Card padding="lg" className="flex w-full flex-col gap-3">
        <AuthIconWell>
          <HomeIcon className="size-6" />
        </AuthIconWell>
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight break-words text-text-primary">
            You’re invited to join {invitation.home.name}
          </h1>
          <p className="text-sm leading-snug text-text-secondary">
            This invitation was sent to{' '}
            <span className="inline-block max-w-full break-words font-medium text-text-primary">
              {invitation.email}.
            </span>
          </p>
          <p className="text-sm leading-snug text-text-secondary">
            Expires {formatExpiration(invitation.expiresAt)}.
          </p>
        </div>
        <div className="flex flex-col gap-3">
          {sessionQuery.isPending ? (
            <p className="flex items-center gap-2 text-sm text-text-secondary">
              <Spinner label="Checking sign-in status" />
            </p>
          ) : null}
          {!sessionQuery.isPending && !signedIn ? (
            <p className="text-sm text-text-secondary">
              Create an account or sign in with this email. Stay here so the
              invitation link does not need to be reopened.
            </p>
          ) : null}
          {needsVerification ? (
            <UnverifiedEmailNotice
              email={session.user.email}
              title={VERIFY_EMAIL_BEFORE_JOINING_TITLE}
              description={VERIFY_EMAIL_BEFORE_JOINING}
              layout="featured"
              showIcon={false}
            />
          ) : null}
          {emailMismatch ? (
            <div className="flex flex-col gap-4">
              <Alert
                variant="warning"
                title="This invitation was sent to a different email."
              >
                You’re signed in as{' '}
                <span className="inline-block max-w-full break-words font-medium">
                  {session.user.email}
                </span>
                . Sign in with the invited email to join this home.
              </Alert>
              <SignOutButton className="w-full" navigateHome={false}>
                Use another account
              </SignOutButton>
            </div>
          ) : null}
          {matchingEmail ? (
            <Button
              className="w-full"
              loading={acceptance.isPending}
              onClick={() => acceptance.mutate()}
            >
              Join Home
            </Button>
          ) : null}
          {acceptanceError === 'EMAIL_NOT_VERIFIED' ? (
            <Alert variant="warning" title={VERIFY_EMAIL_BEFORE_JOINING_TITLE}>
              {VERIFY_EMAIL_BEFORE_JOINING}
            </Alert>
          ) : null}
          {acceptanceError === 'EMAIL_MISMATCH' ? (
            <Alert
              variant="warning"
              title="This invitation was sent to a different email."
            >
              Sign in with the invited email to join this home.
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
      {!sessionQuery.isPending && !signedIn ? (
        <CredentialForm
          defaultEmail={invitation.email}
          defaultMode="sign-up"
          headingLevel="h2"
          signUpHelper={`Create your account to join ${invitation.home.name}.`}
          signInHelper={`Sign in to join ${invitation.home.name}.`}
        />
      ) : null}
    </AuthPageLayout>
  );
}

function InvitationUnavailablePage({ title }: { title: string }) {
  return (
    <InvitationStatusPage title={title} heading="Invitation unavailable">
      <Alert variant="warning" title="This invitation isn’t available">
        The invitation may have expired or is no longer valid. Ask a Home Admin
        for a new invitation if you still need access.
      </Alert>
    </InvitationStatusPage>
  );
}

function InvitationStatusPage({
  title,
  heading,
  children,
}: {
  title: string;
  heading: string;
  children: ReactNode;
}) {
  return (
    <AuthPageLayout title={title} size="invite">
      <Card padding="lg" className="flex w-full flex-col gap-5">
        <AuthIconWell>
          <ExclamationCircleIcon className="size-6" />
        </AuthIconWell>
        <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
          {heading}
        </h1>
        {children}
      </Card>
    </AuthPageLayout>
  );
}
