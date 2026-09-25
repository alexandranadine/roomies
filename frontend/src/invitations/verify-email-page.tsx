import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { UnverifiedEmailNotice } from '../auth/unverified-email-notice.js';
import {
  VERIFICATION_ALREADY_VERIFIED,
  VERIFICATION_ALREADY_VERIFIED_TITLE,
  VERIFICATION_LINK_INVALID,
  VERIFICATION_LINK_INVALID_TITLE,
} from '../auth/verification-copy.js';
import { DocumentTitle } from '../components/document-title.js';
import { Alert } from '../components/ui/index.js';
import {
  getInvitationAuthSession,
  invitationAuthSessionQueryKey,
} from './auth-session-api.js';

/**
 * Better Auth redirects here after GET /api/auth/verify-email.
 * Invitation secrets are never placed on this URL.
 */
export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const linkError = params.get('error');
  const sessionQuery = useQuery({
    queryKey: invitationAuthSessionQueryKey,
    queryFn: ({ signal }) => getInvitationAuthSession(signal),
    retry: false,
  });
  const session = sessionQuery.data;
  const verified = session?.user.emailVerified === true;
  const unverified =
    session !== null &&
    session !== undefined &&
    session.user.emailVerified === false;

  return (
    <DocumentTitle title="Verify email · Roomies">
      <div className="flex max-w-lg flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
          Verify your email
        </h1>
        {linkError ? (
          <Alert variant="warning" title={VERIFICATION_LINK_INVALID_TITLE}>
            {VERIFICATION_LINK_INVALID}
          </Alert>
        ) : null}
        {linkError && unverified ? (
          <UnverifiedEmailNotice email={session.user.email} />
        ) : null}
        {!linkError && sessionQuery.isPending ? (
          <p className="text-base text-text-secondary">
            Checking your verification status.
          </p>
        ) : null}
        {!linkError && verified ? (
          <Alert variant="success" title={VERIFICATION_ALREADY_VERIFIED_TITLE}>
            {VERIFICATION_ALREADY_VERIFIED}
          </Alert>
        ) : null}
        {!linkError && unverified ? (
          <UnverifiedEmailNotice
            email={session.user.email}
            description="Open the verification link Roomies sent you, or send a new one. If you were joining a Home, keep the original invitation link to finish afterward."
          />
        ) : null}
        {!linkError &&
        !sessionQuery.isPending &&
        session == null &&
        !verified ? (
          <Alert variant="warning" title="Use the link from your email">
            Open the verification link Roomies sent you. If you were joining a
            Home, keep the original invitation link to finish afterward.
          </Alert>
        ) : null}
        <p>
          <Link
            to="/"
            className="font-medium text-brand underline-offset-4 hover:text-brand-hover hover:underline focus-visible:rounded-sm"
          >
            Back to Roomies
          </Link>
        </p>
      </div>
    </DocumentTitle>
  );
}
