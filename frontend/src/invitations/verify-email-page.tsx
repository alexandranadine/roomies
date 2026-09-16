import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
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
  const verified = sessionQuery.data?.user.emailVerified === true;

  return (
    <DocumentTitle title="Verify email · Roomies">
      <div className="flex max-w-lg flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
          Verify your email
        </h1>
        {linkError ? (
          <Alert variant="warning" title="This verification link isn’t valid">
            Request a new verification email, then try again. If you were
            joining a Home, reopen the original invitation link afterward.
          </Alert>
        ) : null}
        {!linkError && sessionQuery.isPending ? (
          <p className="text-base text-text-secondary">
            Checking your verification status.
          </p>
        ) : null}
        {!linkError && verified ? (
          <Alert variant="success" title="Your email is verified">
            If you were joining a Home, reopen the original invitation link.
          </Alert>
        ) : null}
        {!linkError && !sessionQuery.isPending && !verified ? (
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
