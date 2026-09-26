import { useQuery } from '@tanstack/react-query';
import {
  CheckBadgeIcon,
  ExclamationCircleIcon,
} from '@heroicons/react/24/outline';
import { Link, useSearchParams } from 'react-router';
import { AuthIconWell, AuthPageLayout } from '../auth/auth-page-layout.js';
import { UnverifiedEmailNotice } from '../auth/unverified-email-notice.js';
import {
  VERIFICATION_ALREADY_VERIFIED,
  VERIFICATION_ALREADY_VERIFIED_TITLE,
  VERIFICATION_LINK_INVALID,
  VERIFICATION_LINK_INVALID_TITLE,
} from '../auth/verification-copy.js';
import { Card, Spinner } from '../components/ui/index.js';
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
    <AuthPageLayout title="Verify email · Roomies">
      <Card padding="lg" className="flex w-full flex-col gap-4">
        {linkError ? (
          <>
            <AuthIconWell>
              <ExclamationCircleIcon className="size-6" />
            </AuthIconWell>
            <div className="flex flex-col gap-1">
              <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
                {VERIFICATION_LINK_INVALID_TITLE}
              </h1>
              <p className="text-sm leading-snug text-text-secondary">
                {VERIFICATION_LINK_INVALID}
              </p>
            </div>
            {unverified ? (
              <UnverifiedEmailNotice
                email={session.user.email}
                layout="featured"
              />
            ) : null}
          </>
        ) : null}
        {!linkError && sessionQuery.isPending ? (
          <div className="flex flex-col items-start gap-4">
            <Spinner label="Checking your verification status" size="md" />
            <div className="flex flex-col gap-1">
              <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
                Checking your email
              </h1>
              <p className="text-sm text-text-secondary">
                Confirming your verification status.
              </p>
            </div>
          </div>
        ) : null}
        {!linkError && verified ? (
          <>
            <AuthIconWell>
              <CheckBadgeIcon className="size-6" />
            </AuthIconWell>
            <div className="flex flex-col gap-1">
              <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
                {VERIFICATION_ALREADY_VERIFIED_TITLE}
              </h1>
              <p className="text-sm leading-snug text-text-secondary">
                {VERIFICATION_ALREADY_VERIFIED}
              </p>
            </div>
          </>
        ) : null}
        {!linkError && unverified ? (
          <UnverifiedEmailNotice
            email={session.user.email}
            layout="featured"
            headingLevel="h1"
            title="Check your email"
            description="Open the verification link Roomies sent you, or send a new one. If you were joining a home, keep the original invitation link to finish afterward."
          />
        ) : null}
        {!linkError &&
        !sessionQuery.isPending &&
        session == null &&
        !verified ? (
          <>
            <AuthIconWell>
              <ExclamationCircleIcon className="size-6" />
            </AuthIconWell>
            <div className="flex flex-col gap-1">
              <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
                Use the link from your email
              </h1>
              <p className="text-sm leading-snug text-text-secondary">
                Open the verification link Roomies sent you. If you were joining
                a home, keep the original invitation link to finish afterward.
              </p>
            </div>
          </>
        ) : null}
        <p>
          <Link
            to="/"
            className="font-medium text-brand underline-offset-4 hover:text-brand-hover hover:underline focus-visible:rounded-sm"
          >
            Back to Roomies
          </Link>
        </p>
      </Card>
    </AuthPageLayout>
  );
}
