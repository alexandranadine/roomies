import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useParams } from 'react-router';
import { DocumentTitle } from '../components/document-title.js';
import { Alert, Button, Card, Spinner } from '../components/ui/index.js';
import { ApiError } from '../platform/api/index.js';
import { shouldRetryQuery } from '../platform/query/query-client.js';
import { getCapturedInvitationSecret } from './capture-invitation-fragment.js';
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
          <Button disabled>Join Home</Button>
          <p className="text-sm text-text-secondary">
            Joining this Home isn’t available yet.
          </p>
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
